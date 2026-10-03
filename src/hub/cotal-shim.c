// cotal-shim: stdio <-> unix-socket relay for paw's cotal hub (src/hub/daemon.mjs). One per claude.
//
// claude launches this as its "cotal" MCP server. It connects to the hub, sends one handshake line
// carrying the session's COTAL_* env, then relays newline-delimited JSON-RPC. If the hub goes away it
// does NOT exit: it answers in-flight and new requests with a JSON-RPC error, reconnects, and replays
// the client's initialize + initialized so claude never sees the MCP server die. The session's
// identity (owner/actor/lifecycle) comes from that same env every time, so a reconnect is the same
// mesh peer with the same DM durable — nothing sent during the gap is lost.
//
// Exits when claude closes stdin, or when the hub says the session is over (the manager's shutdown).
#include <errno.h>
#include <poll.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/un.h>
#include <time.h>
#include <unistd.h>

extern char **environ;

#define MAX_LINE (16 * 1024 * 1024)
#define MAX_PENDING 1024
#define RETRY_MIN_MS 500
#define RETRY_MAX_MS 10000
#define STABLE_MS 5000
#define EXIT_LINE "{\"cotal_hub\":\"exit\"}"

typedef struct { char *b; size_t n, cap; } buf_t;
static const char *sock_path;
static int fd = -1;
static buf_t in_b, hub_b, init_line, inited_line;
static char init_id[64];
static int swallow_init = 0;  // drop the hub's reply to a REPLAYED initialize
static char pending[MAX_PENDING][64];
static int npending = 0;
static long long connected_at = 0, retry_ms = RETRY_MIN_MS;

static void lost_hub(void);

static long long now_ms(void) {
  struct timespec ts; clock_gettime(CLOCK_MONOTONIC, &ts);
  return ts.tv_sec * 1000LL + ts.tv_nsec / 1000000;
}

static void die(const char *m) { fprintf(stderr, "[cotal-shim] %s\n", m); exit(1); }
static void logm(const char *m) { fprintf(stderr, "[cotal-shim] %s\n", m); }

static void bput(buf_t *b, const char *s, size_t n) {
  if (b->n + n > b->cap) {
    size_t c = b->cap ? b->cap : 4096;
    while (c < b->n + n) c *= 2;
    char *nb = realloc(b->b, c);
    if (!nb) die("oom");
    b->b = nb; b->cap = c;
  }
  memcpy(b->b + b->n, s, n); b->n += n;
}

static int write_all(int f, const char *p, size_t n) {
  while (n) {
    ssize_t w = write(f, p, n);
    if (w < 0) { if (errno == EINTR) continue; return -1; }
    p += w; n -= (size_t)w;
  }
  return 0;
}

// Minimal top-level scan of one JSON object: copies the raw value of top-level key `key` into out.
// Returns 1 if found. Strings/escapes/nesting are tracked so a nested "id" never matches.
static int top_key(const char *s, size_t n, const char *key, char *out, size_t outn) {
  size_t klen = strlen(key);
  int depth = 0;
  for (size_t i = 0; i < n; i++) {
    char c = s[i];
    if (c == '"') {
      size_t st = i + 1, j = st;
      while (j < n && s[j] != '"') { if (s[j] == '\\') j++; j++; }
      if (depth == 1 && j - st == klen && !memcmp(s + st, key, klen)) {
        size_t k = j + 1;
        while (k < n && (s[k] == ' ' || s[k] == ':')) k++;
        size_t vs = k;
        if (k < n && s[k] == '"') { k++; while (k < n && s[k] != '"') { if (s[k] == '\\') k++; k++; } k++; }
        else while (k < n && s[k] != ',' && s[k] != '}' && s[k] != ' ') k++;
        size_t vl = k - vs; if (vl >= outn) vl = outn - 1;
        memcpy(out, s + vs, vl); out[vl] = 0;
        return 1;
      }
      i = j;
    } else if (c == '{' || c == '[') depth++;
    else if (c == '}' || c == ']') depth--;
  }
  return 0;
}

static void json_str(buf_t *b, const char *s) {
  bput(b, "\"", 1);
  for (; *s; s++) {
    unsigned char c = (unsigned char)*s;
    if (c == '"' || c == '\\') { bput(b, "\\", 1); bput(b, (char *)&c, 1); }
    else if (c < 0x20) { char e[8]; snprintf(e, sizeof e, "\\u%04x", c); bput(b, e, 6); }
    else bput(b, (char *)&c, 1);
  }
  bput(b, "\"", 1);
}

static void reply_error(const char *id, const char *msg) {
  char out[512];
  int n = snprintf(out, sizeof out, "{\"jsonrpc\":\"2.0\",\"id\":%s,\"error\":{\"code\":-32000,\"message\":\"%s\"}}\n", id, msg);
  write_all(1, out, (size_t)n);
}

static void pend_add(const char *id) { if (npending < MAX_PENDING) strncpy(pending[npending++], id, 63); }
static void pend_del(const char *id) {
  for (int i = 0; i < npending; i++)
    if (!strcmp(pending[i], id)) { pending[i][63] = 0; memcpy(pending[i], pending[--npending], 64); return; }
}
static void fail_pending(void) {
  for (int i = 0; i < npending; i++) reply_error(pending[i], "cotal hub restarting - retry shortly");
  npending = 0;
}

static int try_connect(void) {
  int s = socket(AF_UNIX, SOCK_STREAM, 0);
  if (s < 0) return -1;
  struct sockaddr_un a = {0};
  a.sun_family = AF_UNIX;
  strncpy(a.sun_path, sock_path, sizeof a.sun_path - 1);
  if (connect(s, (struct sockaddr *)&a, sizeof a) < 0) { close(s); return -1; }
  buf_t h = {0};
  bput(&h, "{\"v\":1,\"pid\":", 13);
  char num[32]; int k = snprintf(num, sizeof num, "%d", (int)getppid()); bput(&h, num, (size_t)k);
  bput(&h, ",\"env\":{", 8);
  int first = 1;
  for (char **e = environ; *e; e++) {
    if (strncmp(*e, "COTAL_", 6) && strncmp(*e, "HOME=", 5) && strncmp(*e, "XDG_CONFIG_HOME=", 16)) continue;
    char *eq = strchr(*e, '='); if (!eq) continue;
    char key[256]; size_t kl = (size_t)(eq - *e); if (kl >= sizeof key) continue;
    memcpy(key, *e, kl); key[kl] = 0;
    if (!first) bput(&h, ",", 1);
    first = 0;
    json_str(&h, key); bput(&h, ":", 1); json_str(&h, eq + 1);
  }
  bput(&h, "}}\n", 3);
  int ok = write_all(s, h.b, h.n);
  free(h.b);
  if (ok < 0) { close(s); return -1; }
  return s;
}

static void connect_and_replay(void) {
  fd = try_connect();
  if (fd < 0) return;
  connected_at = now_ms();
  hub_b.n = 0;
  if (init_line.n) {
    write_all(fd, init_line.b, init_line.n);
    swallow_init = 1;
    if (inited_line.n) write_all(fd, inited_line.b, inited_line.n);
    logm("reconnected to hub; replayed initialize");
  }
}

static void on_client_line(char *l, size_t n) {
  char id[64], method[128];
  int has_id = top_key(l, n, "id", id, sizeof id);
  int has_m = top_key(l, n, "method", method, sizeof method);
  if (has_m && !strcmp(method, "\"initialize\"")) { init_line.n = 0; bput(&init_line, l, n); if (has_id) strcpy(init_id, id); }
  if (has_m && !strcmp(method, "\"notifications/initialized\"")) { inited_line.n = 0; bput(&inited_line, l, n); }
  if (fd < 0) {
    if (has_m && has_id) reply_error(id, "cotal hub unavailable - retry shortly");
    return;
  }
  if (has_m && has_id) pend_add(id);
  if (write_all(fd, l, n) < 0) lost_hub();
}

static void on_hub_line(char *l, size_t n) {
  if (n >= sizeof EXIT_LINE - 1 && !memcmp(l, EXIT_LINE, sizeof EXIT_LINE - 1)) { logm("hub ended this session"); exit(0); }
  char id[64];
  int has_id = top_key(l, n, "id", id, sizeof id);
  char method[8];
  int is_resp = has_id && !top_key(l, n, "method", method, sizeof method);
  if (is_resp && swallow_init && !strcmp(id, init_id)) { swallow_init = 0; return; }
  if (is_resp) pend_del(id);
  if (write_all(1, l, n) < 0) exit(0);  // claude gone
}

// Split complete lines out of b and hand each (with its \n) to fn; keep the partial tail.
// A hub that drops us right after accepting (a session it cannot start) must not be hammered: back off
// while connections keep dying young, reset once one has lived STABLE_MS.
static void lost_hub(void) {
  close(fd); fd = -1; hub_b.n = 0; fail_pending();
  retry_ms = now_ms() - connected_at < STABLE_MS ? (retry_ms * 2 > RETRY_MAX_MS ? RETRY_MAX_MS : retry_ms * 2) : RETRY_MIN_MS;
}

static int drain(buf_t *b, void (*fn)(char *, size_t)) {
  size_t start = 0;
  for (size_t i = 0; i < b->n; i++)
    if (b->b[i] == '\n') { fn(b->b + start, i + 1 - start); start = i + 1; }
  memmove(b->b, b->b + start, b->n - start);
  b->n -= start;
  return b->n > MAX_LINE ? -1 : 0;
}

int main(int argc, char **argv) {
  signal(SIGPIPE, SIG_IGN);
  sock_path = argc > 1 ? argv[1] : getenv("COTAL_HUB_SOCKET");
  if (!sock_path || !*sock_path) die("usage: cotal-shim <hub-socket>");
  for (int i = 0; i < 100 && fd < 0; i++) { connect_and_replay(); if (fd < 0) usleep(100000); }
  if (fd < 0) logm("hub not reachable yet; serving errors until it is");
  long long next_retry = 0;
  char rb[65536];
  for (;;) {
    struct pollfd p[2] = {{0, POLLIN, 0}, {fd, POLLIN, 0}};
    int np = fd >= 0 ? 2 : 1;
    if (poll(p, (nfds_t)np, fd >= 0 ? -1 : 500) < 0) { if (errno == EINTR) continue; die("poll"); }
    if (p[0].revents) {
      ssize_t r = read(0, rb, sizeof rb);
      if (r <= 0) { if (r < 0 && errno == EINTR) continue; return 0; }  // claude closed stdin
      bput(&in_b, rb, (size_t)r);
      if (drain(&in_b, on_client_line) < 0) die("client line too long");
    }
    if (fd >= 0 && p[1].revents) {
      ssize_t r = read(fd, rb, sizeof rb);
      if (r <= 0) {
        if (r < 0 && errno == EINTR) continue;
        logm("hub connection lost");
        lost_hub();
      } else {
        bput(&hub_b, rb, (size_t)r);
        if (drain(&hub_b, on_hub_line) < 0) lost_hub();
      }
    }
    if (fd < 0) {
      long long now = now_ms();
      if (now >= next_retry) { connect_and_replay(); next_retry = now + retry_ms; }
    }
  }
}
