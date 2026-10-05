// Package transport is the agent's only door to the world: a cotal mesh endpoint spoken directly
// over NATS/JetStream (no @cotal-ai/core, which exists only in TS). Open-mode (unauthenticated
// localhost broker, paw's default) subset of the cotal wire contract, reverse-engineered from
// @cotal-ai/core 0.66.1 with lean/tools/sniff-cotal.ts:
//
//	presence   KV cotal_presence_<space>, key <owner>.<actor>, JSON {card, lifecycleUid, status,
//	           statusSince, ts}, re-put every 2s (the bucket's TTL expires a dead endpoint);
//	           status "offline" on a clean stop
//	DM out     JetStream publish cotal.<space>.inst.<toOwner>.<toActor>.<myOwner>.<myActor>,
//	           header Nats-Msg-Id = message id
//	DM in      durable pull consumer dm_<owner>-<actor>-<lifecycleUid> on stream DM_<space>,
//	           filter cotal.<space>.inst.<owner>.<actor>.>, explicit ack
//	channel    publish cotal.<space>.chat.<owner>.<actor>.<channel> (JetStream, CHAT_<space>);
//	           live reads are a core subscription to cotal.<space>.chat.*.*.<channel>
//	message    {id, ts, space, from:{id,name}, to | channel, parts:[{kind:"text", text}]}
//
// Not implemented (documented in docs/notes/lean-harness-poc.md): JWT/auth mode, the v0.4
// endpoint service rails (describe/control), channel history replay, mentions/attention modes,
// anycast, the AG-UI event channel.
package transport

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"math/big"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/nats-io/nats.go"
	"github.com/nats-io/nats.go/jetstream"
)

const owner = "local" // cotal's DEV_OWNER: every open-mode principal is local.<actor>

type Config struct {
	Server   string
	Space    string
	Name     string
	Channels []string
	// StateDir keeps the stable actor id and the last acked DM sequence across restarts.
	StateDir string
	Meta     map[string]string
}

type Ref struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

type Part struct {
	Kind string `json:"kind"`
	Text string `json:"text,omitempty"`
}

type wireMsg struct {
	ID      string `json:"id"`
	TS      int64  `json:"ts"`
	Space   string `json:"space"`
	From    Ref    `json:"from"`
	To      string `json:"to,omitempty"`
	Channel string `json:"channel,omitempty"`
	Parts   []Part `json:"parts"`
}

// Inbound is one message for the agent. Ack it once the engine has taken it into a turn; an
// unacked DM is redelivered after the consumer's ack wait (60s).
type Inbound struct {
	ID      string
	From    Ref
	Channel string // "" for a DM
	Text    string
	ack     func() error
}

func (m *Inbound) Ack() error { return m.ack() }

// NewInbound builds a message that needs no ack (local runs, tests).
func NewInbound(id string, from Ref, channel, text string) *Inbound {
	return &Inbound{ID: id, From: from, Channel: channel, Text: text, ack: func() error { return nil }}
}

type Peer struct {
	ID     string
	Name   string
	Kind   string
	Status string
	TS     int64
}

type card struct {
	Name  string            `json:"name"`
	Kind  string            `json:"kind"`
	Meta  map[string]string `json:"meta,omitempty"`
	ID    string            `json:"id"`
	Owner string            `json:"owner"`
	Actor string            `json:"actor"`
}

type presence struct {
	Card         card   `json:"card"`
	LifecycleUID string `json:"lifecycleUid"`
	Status       string `json:"status"`
	StatusSince  int64  `json:"statusSince,omitempty"`
	TS           int64  `json:"ts"`
}

type identity struct {
	Actor     string `json:"actor"`
	LastDMSeq uint64 `json:"lastDmSeq"`
}

type Client struct {
	cfg      Config
	nc       *nats.Conn
	js       jetstream.JetStream
	kv       jetstream.KeyValue
	durable  string
	consumer jetstream.ConsumeContext
	subs     []*nats.Subscription
	inbox    chan *Inbound

	mu     sync.Mutex
	me     presence
	ident  identity
	roster map[string]Peer
	stop   chan struct{}
	wg     sync.WaitGroup
}

func now() int64 { return time.Now().UnixMilli() }

func randHex(n int) string {
	b := make([]byte, n)
	rand.Read(b)
	return hex.EncodeToString(b)
}

func lifecycleUID() string {
	b := make([]byte, 20)
	rand.Read(b)
	s := new(big.Int).SetBytes(b).Text(36)
	for len(s) < 26 {
		s = "0" + s
	}
	return s
}

func msgID() string {
	b := make([]byte, 16)
	rand.Read(b)
	b[6] = b[6]&0x0f | 0x40
	b[8] = b[8]&0x3f | 0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:16])
}

func (c *Client) identPath() string { return filepath.Join(c.cfg.StateDir, "identity.json") }

func (c *Client) loadIdentity() error {
	if err := os.MkdirAll(c.cfg.StateDir, 0o700); err != nil {
		return err
	}
	b, err := os.ReadFile(c.identPath())
	if errors.Is(err, os.ErrNotExist) {
		c.ident = identity{Actor: randHex(16)}
		return c.saveIdentity()
	}
	if err != nil {
		return err
	}
	if err := json.Unmarshal(b, &c.ident); err != nil {
		return fmt.Errorf("%s: %w", c.identPath(), err)
	}
	if c.ident.Actor == "" {
		return fmt.Errorf("%s has no actor", c.identPath())
	}
	return nil
}

func (c *Client) saveIdentity() error {
	b, _ := json.Marshal(c.ident)
	tmp := c.identPath() + ".tmp"
	if err := os.WriteFile(tmp, b, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, c.identPath())
}

func (c *Client) prefix() string { return "cotal." + c.cfg.Space }

// ID is the agent's wire identity (card.id), <owner>.<actor>.
func (c *Client) ID() string { return owner + "." + c.ident.Actor }

func Connect(ctx context.Context, cfg Config) (*Client, error) {
	if cfg.Name == "" || strings.TrimSpace(cfg.Name) != cfg.Name || strings.Contains(cfg.Name, "/") {
		return nil, fmt.Errorf("invalid agent name %q", cfg.Name)
	}
	c := &Client{cfg: cfg, inbox: make(chan *Inbound, 256), roster: map[string]Peer{}, stop: make(chan struct{})}
	if err := c.loadIdentity(); err != nil {
		return nil, err
	}
	nc, err := nats.Connect(cfg.Server, nats.Name("cotal:"+cfg.Name), nats.MaxReconnects(-1), nats.ReconnectWait(time.Second))
	if err != nil {
		return nil, fmt.Errorf("connect %s: %w", cfg.Server, err)
	}
	c.nc = nc
	if c.js, err = jetstream.New(nc); err != nil {
		return nil, err
	}
	// The mesh is set up by `cotal up` / paw's ensure(); an endpoint never invents infrastructure.
	for _, s := range []string{"DM_" + cfg.Space, "CHAT_" + cfg.Space} {
		if _, err := c.js.Stream(ctx, s); err != nil {
			nc.Close()
			return nil, fmt.Errorf("stream %s: %w — is the %q mesh up (paw ensure / cotal up)?", s, err, cfg.Space)
		}
	}
	if c.kv, err = c.js.KeyValue(ctx, "cotal_presence_"+cfg.Space); err != nil {
		nc.Close()
		return nil, fmt.Errorf("presence bucket: %w", err)
	}
	t := now()
	c.me = presence{
		Card:         card{Name: cfg.Name, Kind: "agent", Meta: cfg.Meta, ID: c.ID(), Owner: owner, Actor: c.ident.Actor},
		LifecycleUID: lifecycleUID(), Status: "idle", StatusSince: t, TS: t,
	}
	if err := c.watchRoster(ctx); err != nil {
		nc.Close()
		return nil, err
	}
	if err := c.bindDMs(ctx); err != nil {
		nc.Close()
		return nil, err
	}
	for _, ch := range cfg.Channels {
		sub, err := nc.Subscribe(fmt.Sprintf("%s.chat.*.*.%s", c.prefix(), ch), c.onChat)
		if err != nil {
			nc.Close()
			return nil, err
		}
		c.subs = append(c.subs, sub)
	}
	if err := c.putPresence(ctx); err != nil {
		nc.Close()
		return nil, err
	}
	c.wg.Add(1)
	go c.heartbeat()
	return c, nil
}

func (c *Client) bindDMs(ctx context.Context) error {
	stream, err := c.js.Stream(ctx, "DM_"+c.cfg.Space)
	if err != nil {
		return err
	}
	c.durable = fmt.Sprintf("dm_%s-%s-%s", owner, c.ident.Actor, c.me.LifecycleUID)
	cc := jetstream.ConsumerConfig{
		Durable:           c.durable,
		FilterSubject:     fmt.Sprintf("%s.inst.%s.%s.>", c.prefix(), owner, c.ident.Actor),
		AckPolicy:         jetstream.AckExplicitPolicy,
		AckWait:           60 * time.Second,
		InactiveThreshold: 10 * time.Minute,
	}
	// Resume exactly after the last DM this agent acked (a restart, or an offline stretch longer
	// than the old durable's inactivity window); a first boot starts from now.
	if c.ident.LastDMSeq > 0 {
		cc.DeliverPolicy, cc.OptStartSeq = jetstream.DeliverByStartSequencePolicy, c.ident.LastDMSeq+1
	} else {
		info, err := stream.Info(ctx)
		if err != nil {
			return err
		}
		cc.DeliverPolicy, cc.OptStartSeq = jetstream.DeliverByStartSequencePolicy, info.State.LastSeq+1
		c.ident.LastDMSeq = info.State.LastSeq
		if err := c.saveIdentity(); err != nil {
			return err
		}
	}
	cons, err := stream.CreateOrUpdateConsumer(ctx, cc)
	if err != nil {
		return fmt.Errorf("DM durable %s: %w", c.durable, err)
	}
	c.consumer, err = cons.Consume(func(m jetstream.Msg) {
		var w wireMsg
		if err := json.Unmarshal(m.Data(), &w); err != nil {
			fmt.Fprintf(os.Stderr, "[cotal] dropping undecodable DM on %s: %v\n", m.Subject(), err)
			m.Term()
			return
		}
		md, err := m.Metadata()
		if err != nil {
			fmt.Fprintf(os.Stderr, "[cotal] DM without JetStream metadata: %v\n", err)
			return
		}
		seq := md.Sequence.Stream
		c.inbox <- &Inbound{ID: w.ID, From: w.From, Text: partsText(w.Parts), ack: func() error {
			if err := m.DoubleAck(context.Background()); err != nil {
				return err
			}
			c.mu.Lock()
			defer c.mu.Unlock()
			if seq > c.ident.LastDMSeq {
				c.ident.LastDMSeq = seq
			}
			return c.saveIdentity()
		}}
	})
	return err
}

func partsText(parts []Part) string {
	var out []string
	for _, p := range parts {
		if p.Kind == "text" {
			out = append(out, p.Text)
		} else {
			b, _ := json.Marshal(p)
			out = append(out, "[part "+string(b)+"]")
		}
	}
	return strings.Join(out, "\n")
}

func (c *Client) onChat(m *nats.Msg) {
	var w wireMsg
	if err := json.Unmarshal(m.Data, &w); err != nil {
		fmt.Fprintf(os.Stderr, "[cotal] dropping undecodable channel message on %s: %v\n", m.Subject, err)
		return
	}
	if w.From.ID == c.ID() {
		return
	}
	c.inbox <- &Inbound{ID: w.ID, From: w.From, Channel: w.Channel, Text: partsText(w.Parts), ack: func() error { return nil }}
}

func (c *Client) watchRoster(ctx context.Context) error {
	// not the connect ctx: a watcher lives as long as its context, and the agent outlives connect
	w, err := c.kv.WatchAll(context.Background())
	if err != nil {
		return err
	}
	ready := make(chan struct{})
	c.wg.Add(1)
	go func() {
		defer c.wg.Done()
		defer w.Stop()
		first := true
		for {
			select {
			case <-c.stop:
				return
			case e, ok := <-w.Updates():
				if !ok {
					return
				}
				if e == nil {
					if first {
						first = false
						close(ready)
					}
					continue
				}
				c.mu.Lock()
				if e.Operation() != jetstream.KeyValuePut {
					delete(c.roster, e.Key())
				} else {
					var p presence
					if json.Unmarshal(e.Value(), &p) == nil {
						c.roster[e.Key()] = Peer{ID: p.Card.ID, Name: p.Card.Name, Kind: p.Card.Kind, Status: p.Status, TS: p.TS}
					}
				}
				c.mu.Unlock()
			}
		}
	}()
	select {
	case <-ready:
		return nil
	case <-time.After(10 * time.Second):
		return errors.New("presence watch never delivered its initial snapshot")
	}
}

func (c *Client) putPresence(ctx context.Context) error {
	c.mu.Lock()
	c.me.TS = now()
	b, _ := json.Marshal(c.me)
	c.mu.Unlock()
	_, err := c.kv.Put(ctx, c.ID(), b)
	return err
}

func (c *Client) heartbeat() {
	defer c.wg.Done()
	t := time.NewTicker(2 * time.Second)
	defer t.Stop()
	for {
		select {
		case <-c.stop:
			return
		case <-t.C:
			ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
			if err := c.putPresence(ctx); err != nil {
				fmt.Fprintf(os.Stderr, "[cotal] presence heartbeat failed: %v\n", err)
			}
			cancel()
		}
	}
}

func (c *Client) Inbox() <-chan *Inbound { return c.inbox }

// SetStatus publishes idle/working immediately (not at the next heartbeat).
func (c *Client) SetStatus(status string) error {
	c.mu.Lock()
	if c.me.Status != status {
		c.me.Status, c.me.StatusSince = status, now()
	}
	c.mu.Unlock()
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	return c.putPresence(ctx)
}

// Roster lists live peers (fresh heartbeat, not offline), self excluded.
func (c *Client) Roster() []Peer {
	c.mu.Lock()
	defer c.mu.Unlock()
	var out []Peer
	for _, p := range c.roster {
		if p.ID != c.ID() && p.Status != "offline" && now()-p.TS < 6000 {
			out = append(out, p)
		}
	}
	return out
}

// resolve accepts a peer name or a card id. A name that matches several live peers is refused.
func (c *Client) resolve(to string) (Ref, error) {
	var hits []Peer
	for _, p := range c.Roster() {
		if p.ID == to || p.Name == to {
			hits = append(hits, p)
		}
	}
	switch len(hits) {
	case 0:
		return Ref{}, fmt.Errorf("no live peer named %q on the mesh (cotal_roster lists who is online)", to)
	case 1:
		return Ref{ID: hits[0].ID, Name: hits[0].Name}, nil
	}
	return Ref{}, fmt.Errorf("%q is ambiguous: %d live peers carry that name — address one by id", to, len(hits))
}

func (c *Client) publish(subject string, w wireMsg) error {
	b, _ := json.Marshal(w)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_, err := c.js.Publish(ctx, subject, b, jetstream.WithMsgID(w.ID))
	return err
}

// DM sends a direct message to a peer by name or id; returns the resolved id.
func (c *Client) DM(to, text string) (Ref, error) {
	r, err := c.resolve(to)
	if err != nil {
		return Ref{}, err
	}
	parts := strings.SplitN(r.ID, ".", 2)
	if len(parts) != 2 {
		return Ref{}, fmt.Errorf("peer id %q is not <owner>.<actor>", r.ID)
	}
	w := wireMsg{ID: msgID(), TS: now(), Space: c.cfg.Space, From: Ref{ID: c.ID(), Name: c.cfg.Name}, To: r.ID, Parts: []Part{{Kind: "text", Text: text}}}
	return r, c.publish(fmt.Sprintf("%s.inst.%s.%s.%s.%s", c.prefix(), parts[0], parts[1], owner, c.ident.Actor), w)
}

// Send posts to a channel.
func (c *Client) Send(channel, text string) error {
	for _, seg := range strings.Split(channel, ".") {
		if seg == "" || strings.ContainsAny(seg, "*> ") {
			return fmt.Errorf("invalid channel %q", channel)
		}
	}
	w := wireMsg{ID: msgID(), TS: now(), Space: c.cfg.Space, From: Ref{ID: c.ID(), Name: c.cfg.Name}, Channel: channel, Parts: []Part{{Kind: "text", Text: text}}}
	return c.publish(fmt.Sprintf("%s.chat.%s.%s.%s", c.prefix(), owner, c.ident.Actor, channel), w)
}

// Close marks the agent offline, removes its DM durable (the next boot resumes from the saved
// sequence) and disconnects.
func (c *Client) Close() error {
	close(c.stop)
	if c.consumer != nil {
		c.consumer.Stop()
	}
	for _, s := range c.subs {
		s.Unsubscribe()
	}
	c.mu.Lock()
	c.me.Status = "offline"
	c.me.StatusSince = 0
	c.mu.Unlock()
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	err := c.putPresence(ctx)
	if s, serr := c.js.Stream(ctx, "DM_"+c.cfg.Space); serr == nil {
		s.DeleteConsumer(ctx, c.durable)
	}
	c.wg.Wait()
	c.nc.Close()
	return err
}
