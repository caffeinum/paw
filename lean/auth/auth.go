// Package auth gets a subscription OAuth bearer for a provider.
//
// Resolution order, per provider:
//  1. lean's OWN login (`lean login openai|xai`, a device flow): tokens in
//     <LEAN_HOME>/auth.json (mode 0600), refreshed here when they near expiry.
//  2. a BORROWED login the operator already has — codex CLI's ~/.codex/auth.json (openai) or
//     opencode's ~/.local/share/opencode/auth.json (xai). Read-only: the access token is used only
//     while it is still valid and is NEVER refreshed from here, because both providers rotate
//     refresh tokens and refreshing would silently log the operator's own tool out. Re-read on
//     every call, so when codex/opencode refresh their own token lean picks it up.
//  3. nothing usable → an error naming the one command to run.
//
// Token values are never printed or logged, and never copied out of the file they came from.
package auth

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

type Token struct {
	Access    string `json:"access"`
	Refresh   string `json:"refresh,omitempty"`
	Expires   int64  `json:"expires"` // unix ms
	AccountID string `json:"accountId,omitempty"`
}

// Source yields a valid bearer for one provider.
type Source struct {
	Provider string // "openai" | "xai"
	Home     string // LEAN_HOME
	mu       sync.Mutex
	origin   string
}

const margin = 2 * time.Minute

func Home() string {
	if h := os.Getenv("LEAN_HOME"); h != "" {
		return h
	}
	if h := os.Getenv("PAW_HOME"); h != "" {
		return filepath.Join(h, "lean")
	}
	home, _ := os.UserHomeDir()
	return filepath.Join(home, ".paw", "lean")
}

func storePath(home string) string { return filepath.Join(home, "auth.json") }

func readStore(home string) (map[string]Token, error) {
	b, err := os.ReadFile(storePath(home))
	if errors.Is(err, os.ErrNotExist) {
		return map[string]Token{}, nil
	}
	if err != nil {
		return nil, err
	}
	st, err := os.Stat(storePath(home))
	if err == nil && st.Mode().Perm()&0o077 != 0 {
		return nil, fmt.Errorf("%s is readable by others (mode %o) — chmod 600 it", storePath(home), st.Mode().Perm())
	}
	m := map[string]Token{}
	if err := json.Unmarshal(b, &m); err != nil {
		return nil, fmt.Errorf("%s: %w", storePath(home), err)
	}
	return m, nil
}

// Save writes one provider's tokens into lean's own store (0600, atomic).
func Save(home, provider string, t Token) error {
	if err := os.MkdirAll(home, 0o700); err != nil {
		return err
	}
	m, err := readStore(home)
	if err != nil {
		return err
	}
	m[provider] = t
	b, _ := json.MarshalIndent(m, "", "  ")
	tmp := storePath(home) + ".tmp"
	if err := os.WriteFile(tmp, b, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, storePath(home))
}

// Origin says where the last token came from (no secret in it).
func (s *Source) Origin() string { return s.origin }

func loginHint(provider string) string {
	return fmt.Sprintf("run `go run ./cmd/lean login %s` in lean/ (or the built binary: `lean login %s`)", provider, provider)
}

func (s *Source) Token(ctx context.Context) (Token, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	m, err := readStore(s.Home)
	if err != nil {
		return Token{}, err
	}
	if t, ok := m[s.Provider]; ok {
		if time.UnixMilli(t.Expires).After(time.Now().Add(margin)) {
			s.origin = "lean login"
			return t, nil
		}
		nt, err := refresh(ctx, s.Provider, t)
		if err != nil {
			return Token{}, fmt.Errorf("%s: refreshing lean's own login failed (%v) — %s", s.Provider, err, loginHint(s.Provider))
		}
		if err := Save(s.Home, s.Provider, nt); err != nil {
			return Token{}, err
		}
		s.origin = "lean login (refreshed)"
		return nt, nil
	}
	t, where, err := borrowed(s.Provider)
	if err != nil {
		return Token{}, err
	}
	if t == nil {
		return Token{}, fmt.Errorf("%s: no subscription login found — %s", s.Provider, loginHint(s.Provider))
	}
	if !time.UnixMilli(t.Expires).After(time.Now().Add(margin)) {
		return Token{}, fmt.Errorf("%s: the token borrowed from %s has expired and lean never refreshes another tool's login — %s, or let %s refresh its own token", s.Provider, where, loginHint(s.Provider), map[string]string{"openai": "codex", "xai": "opencode"}[s.Provider])
	}
	s.origin = "borrowed from " + where
	return *t, nil
}

// jwtClaims decodes a JWT payload WITHOUT verifying it (used only for exp / account id).
func jwtClaims(tok string) map[string]any {
	parts := strings.Split(tok, ".")
	if len(parts) < 2 {
		return nil
	}
	b, err := base64.RawURLEncoding.DecodeString(strings.TrimRight(parts[1], "="))
	if err != nil {
		return nil
	}
	var m map[string]any
	json.Unmarshal(b, &m)
	return m
}

func jwtExpiry(tok string) int64 {
	if f, ok := jwtClaims(tok)["exp"].(float64); ok {
		return int64(f) * 1000
	}
	return 0
}

func borrowed(provider string) (*Token, string, error) {
	home, _ := os.UserHomeDir()
	switch provider {
	case "openai":
		p := filepath.Join(home, ".codex", "auth.json")
		b, err := os.ReadFile(p)
		if errors.Is(err, os.ErrNotExist) {
			return nil, p, nil
		}
		if err != nil {
			return nil, p, err
		}
		var f struct {
			Mode   string `json:"auth_mode"`
			Tokens *struct {
				Access    string `json:"access_token"`
				AccountID string `json:"account_id"`
			} `json:"tokens"`
		}
		if err := json.Unmarshal(b, &f); err != nil {
			return nil, p, fmt.Errorf("%s: %w", p, err)
		}
		if f.Tokens == nil || f.Tokens.Access == "" || f.Mode != "chatgpt" {
			return nil, p, nil
		}
		return &Token{Access: f.Tokens.Access, AccountID: f.Tokens.AccountID, Expires: jwtExpiry(f.Tokens.Access)}, "codex (~/.codex/auth.json)", nil
	case "xai":
		p := filepath.Join(home, ".local", "share", "opencode", "auth.json")
		b, err := os.ReadFile(p)
		if errors.Is(err, os.ErrNotExist) {
			return nil, p, nil
		}
		if err != nil {
			return nil, p, err
		}
		var f map[string]struct {
			Type    string `json:"type"`
			Access  string `json:"access"`
			Expires int64  `json:"expires"`
		}
		if err := json.Unmarshal(b, &f); err != nil {
			return nil, p, fmt.Errorf("%s: %w", p, err)
		}
		x, ok := f["xai"]
		if !ok || x.Type != "oauth" || x.Access == "" {
			return nil, p, nil
		}
		return &Token{Access: x.Access, Expires: x.Expires}, "opencode (~/.local/share/opencode/auth.json)", nil
	}
	return nil, "", fmt.Errorf("unknown provider %q", provider)
}

// ---- OAuth endpoints (public clients; the same ones codex CLI and opencode use) ----------------

const (
	openaiIssuer   = "https://auth.openai.com"
	openaiClientID = "app_EMoamEEZ73f0CkXaXp7hrann"
	xaiToken       = "https://auth.x.ai/oauth2/token"
	xaiDevice      = "https://auth.x.ai/oauth2/device/code"
	xaiClientID    = "b1a00492-073a-47ea-816f-4c329264a828"
	xaiScope       = "openid profile email offline_access grok-cli:access api:access"
)

type tokenResp struct {
	IDToken      string `json:"id_token"`
	AccessToken  string `json:"access_token"`
	RefreshToken string `json:"refresh_token"`
	ExpiresIn    int64  `json:"expires_in"`
	Error        string `json:"error"`
	ErrorDesc    string `json:"error_description"`
}

func postForm(ctx context.Context, u string, form url.Values, out any) (int, error) {
	req, _ := http.NewRequestWithContext(ctx, "POST", u, strings.NewReader(form.Encode()))
	req.Header.Set("content-type", "application/x-www-form-urlencoded")
	req.Header.Set("accept", "application/json")
	return do(req, out)
}

func postJSON(ctx context.Context, u string, body any, out any) (int, error) {
	b, _ := json.Marshal(body)
	req, _ := http.NewRequestWithContext(ctx, "POST", u, strings.NewReader(string(b)))
	req.Header.Set("content-type", "application/json")
	return do(req, out)
}

func do(req *http.Request, out any) (int, error) {
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		return 0, err
	}
	defer res.Body.Close()
	if out != nil {
		json.NewDecoder(res.Body).Decode(out)
	}
	return res.StatusCode, nil
}

func fromResp(r tokenResp, prev Token) Token {
	t := Token{Access: r.AccessToken, Refresh: r.RefreshToken, Expires: time.Now().Add(time.Duration(r.ExpiresIn) * time.Second).UnixMilli(), AccountID: prev.AccountID}
	if r.ExpiresIn == 0 {
		t.Expires = jwtExpiry(r.AccessToken)
	}
	if t.Refresh == "" {
		t.Refresh = prev.Refresh
	}
	if id := openaiAccount(r.IDToken); id != "" {
		t.AccountID = id
	} else if id := openaiAccount(r.AccessToken); id != "" {
		t.AccountID = id
	}
	return t
}

func openaiAccount(jwt string) string {
	c := jwtClaims(jwt)
	if a, ok := c["https://api.openai.com/auth"].(map[string]any); ok {
		if s, ok := a["chatgpt_account_id"].(string); ok {
			return s
		}
	}
	if s, ok := c["chatgpt_account_id"].(string); ok {
		return s
	}
	return ""
}

func refresh(ctx context.Context, provider string, t Token) (Token, error) {
	if t.Refresh == "" {
		return Token{}, errors.New("no refresh token stored")
	}
	var r tokenResp
	var code int
	var err error
	switch provider {
	case "openai":
		code, err = postForm(ctx, openaiIssuer+"/oauth/token", url.Values{"grant_type": {"refresh_token"}, "refresh_token": {t.Refresh}, "client_id": {openaiClientID}}, &r)
	case "xai":
		code, err = postForm(ctx, xaiToken, url.Values{"grant_type": {"refresh_token"}, "refresh_token": {t.Refresh}, "client_id": {xaiClientID}}, &r)
	default:
		return Token{}, fmt.Errorf("unknown provider %q", provider)
	}
	if err != nil {
		return Token{}, err
	}
	if code != 200 || r.AccessToken == "" {
		return Token{}, fmt.Errorf("token endpoint answered %d %s", code, r.Error)
	}
	return fromResp(r, t), nil
}

// Login runs a device-authorization flow: it prints a URL and a code for the operator to enter in
// a browser of their choosing, polls until approved, and stores the tokens. It never opens or
// drives a browser itself.
func Login(ctx context.Context, home, provider string, say func(string)) error {
	var t Token
	var err error
	switch provider {
	case "openai":
		t, err = loginOpenAI(ctx, say)
	case "xai":
		t, err = loginXAI(ctx, say)
	default:
		return fmt.Errorf("unknown provider %q (openai | xai)", provider)
	}
	if err != nil {
		return err
	}
	if err := Save(home, provider, t); err != nil {
		return err
	}
	say(fmt.Sprintf("logged in to %s; tokens stored in %s (0600)", provider, storePath(home)))
	return nil
}

func loginOpenAI(ctx context.Context, say func(string)) (Token, error) {
	var dc struct {
		DeviceAuthID string `json:"device_auth_id"`
		UserCode     string `json:"user_code"`
		Interval     any    `json:"interval"`
	}
	code, err := postJSON(ctx, openaiIssuer+"/api/accounts/deviceauth/usercode", map[string]string{"client_id": openaiClientID}, &dc)
	if err != nil {
		return Token{}, err
	}
	if code != 200 || dc.DeviceAuthID == "" {
		return Token{}, fmt.Errorf("device authorization request answered %d", code)
	}
	say(fmt.Sprintf("Open %s/codex/device in your browser and enter the code: %s", openaiIssuer, dc.UserCode))
	interval := 5 * time.Second
	for deadline := time.Now().Add(15 * time.Minute); time.Now().Before(deadline); {
		select {
		case <-ctx.Done():
			return Token{}, ctx.Err()
		case <-time.After(interval + time.Second):
		}
		var tr struct {
			AuthorizationCode string `json:"authorization_code"`
			CodeVerifier      string `json:"code_verifier"`
		}
		code, err := postJSON(ctx, openaiIssuer+"/api/accounts/deviceauth/token", map[string]string{"device_auth_id": dc.DeviceAuthID, "user_code": dc.UserCode}, &tr)
		if err != nil {
			return Token{}, err
		}
		if code == 403 || code == 404 {
			continue
		}
		if code != 200 {
			return Token{}, fmt.Errorf("device token poll answered %d", code)
		}
		var r tokenResp
		code, err = postForm(ctx, openaiIssuer+"/oauth/token", url.Values{
			"grant_type": {"authorization_code"}, "code": {tr.AuthorizationCode},
			"redirect_uri": {openaiIssuer + "/deviceauth/callback"}, "client_id": {openaiClientID}, "code_verifier": {tr.CodeVerifier},
		}, &r)
		if err != nil {
			return Token{}, err
		}
		if code != 200 || r.AccessToken == "" {
			return Token{}, fmt.Errorf("token exchange answered %d %s", code, r.Error)
		}
		t := fromResp(r, Token{})
		if t.AccountID == "" {
			return Token{}, errors.New("the OpenAI token carries no chatgpt_account_id — is this a ChatGPT plan login?")
		}
		return t, nil
	}
	return Token{}, errors.New("device authorization timed out")
}

func loginXAI(ctx context.Context, say func(string)) (Token, error) {
	var dc struct {
		DeviceCode              string `json:"device_code"`
		UserCode                string `json:"user_code"`
		VerificationURI         string `json:"verification_uri"`
		VerificationURIComplete string `json:"verification_uri_complete"`
		Interval                int    `json:"interval"`
		ExpiresIn               int    `json:"expires_in"`
	}
	code, err := postForm(ctx, xaiDevice, url.Values{"client_id": {xaiClientID}, "scope": {xaiScope}, "referrer": {"paw-lean"}}, &dc)
	if err != nil {
		return Token{}, err
	}
	if code != 200 || dc.DeviceCode == "" {
		return Token{}, fmt.Errorf("device code request answered %d", code)
	}
	say(fmt.Sprintf("Open %s in your browser and enter the code: %s", dc.VerificationURI, dc.UserCode))
	interval := time.Duration(max(dc.Interval, 5)) * time.Second
	expires := time.Duration(max(dc.ExpiresIn, 300)) * time.Second
	for deadline := time.Now().Add(expires); time.Now().Before(deadline); {
		select {
		case <-ctx.Done():
			return Token{}, ctx.Err()
		case <-time.After(interval):
		}
		var r tokenResp
		code, err := postForm(ctx, xaiToken, url.Values{"grant_type": {"urn:ietf:params:oauth:grant-type:device_code"}, "client_id": {xaiClientID}, "device_code": {dc.DeviceCode}}, &r)
		if err != nil {
			return Token{}, err
		}
		if code == 200 && r.AccessToken != "" {
			return fromResp(r, Token{}), nil
		}
		switch r.Error {
		case "authorization_pending":
			continue
		case "slow_down":
			interval += 5 * time.Second
			continue
		}
		return Token{}, fmt.Errorf("device token poll answered %d %s", code, r.Error)
	}
	return Token{}, errors.New("device authorization timed out")
}

// Status describes, without secrets, where each provider's token would come from.
func Status(home string) []string {
	var out []string
	m, err := readStore(home)
	if err != nil {
		return []string{err.Error()}
	}
	for _, p := range []string{"openai", "xai"} {
		if t, ok := m[p]; ok {
			out = append(out, fmt.Sprintf("%s: lean login, expires %s, refreshable=%v", p, time.UnixMilli(t.Expires).Format(time.RFC3339), t.Refresh != ""))
			continue
		}
		t, where, err := borrowed(p)
		switch {
		case err != nil:
			out = append(out, fmt.Sprintf("%s: %v", p, err))
		case t == nil:
			out = append(out, fmt.Sprintf("%s: no login — %s", p, loginHint(p)))
		default:
			out = append(out, fmt.Sprintf("%s: borrowed from %s, expires %s (valid=%v; never refreshed by lean)", p, where, time.UnixMilli(t.Expires).Format(time.RFC3339), time.UnixMilli(t.Expires).After(time.Now().Add(margin))))
		}
	}
	return out
}
