package provider

import (
	"bufio"
	"fmt"
	"io"
	"net/http"
	"strings"
)

// readSSE calls fn with each `data:` payload of a text/event-stream body ("[DONE]" ends it).
func readSSE(body io.Reader, fn func(data []byte) error) error {
	sc := bufio.NewScanner(body)
	sc.Buffer(make([]byte, 1<<20), 64<<20)
	var data strings.Builder
	flush := func() error {
		if data.Len() == 0 {
			return nil
		}
		d := data.String()
		data.Reset()
		if d == "[DONE]" {
			return io.EOF
		}
		return fn([]byte(d))
	}
	for sc.Scan() {
		line := sc.Text()
		switch {
		case line == "":
			if err := flush(); err != nil {
				if err == io.EOF {
					return nil
				}
				return err
			}
		case strings.HasPrefix(line, "data:"):
			if data.Len() > 0 {
				data.WriteByte('\n')
			}
			data.WriteString(strings.TrimPrefix(strings.TrimPrefix(line, "data:"), " "))
		}
	}
	if err := sc.Err(); err != nil {
		return err
	}
	if err := flush(); err != nil && err != io.EOF {
		return err
	}
	return nil
}

func httpError(res *http.Response) error {
	b, _ := io.ReadAll(io.LimitReader(res.Body, 2000))
	return fmt.Errorf("%s %s: HTTP %d: %s", res.Request.Method, res.Request.URL.Host+res.Request.URL.Path, res.StatusCode, strings.TrimSpace(string(b)))
}
