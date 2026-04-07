package agent

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"os/exec"
	"strings"
	"sync"
	"time"
)

// acpBackend implements Backend for any ACP-compatible agent CLI.
// It spawns the agent with the configured command + args, then speaks
// ACP (Agent Communication Protocol) over stdin/stdout using JSON-RPC 2.0.
//
// Flow:
//  1. initialize  — capability handshake
//  2. session/new — create an isolated session (returns sessionId)
//  3. session/prompt — send the prompt; blocks until the agent responds
//
// During step 3 the agent sends session/update notifications (streaming text,
// tool calls, thoughts) and may send permission/request server-requests that
// the client must respond to (auto-approved in daemon mode).
type acpBackend struct {
	cfg         Config
	defaultExec string   // default executable name when cfg.ExecutablePath is empty
	startArgs   []string // args appended after the executable (e.g. ["acp"])
}

func (b *acpBackend) Execute(ctx context.Context, prompt string, opts ExecOptions) (*Session, error) {
	execPath := b.cfg.ExecutablePath
	if execPath == "" {
		execPath = b.defaultExec
	}
	if _, err := exec.LookPath(execPath); err != nil {
		return nil, fmt.Errorf("%s executable not found at %q: %w", b.defaultExec, execPath, err)
	}

	timeout := opts.Timeout
	if timeout == 0 {
		timeout = 20 * time.Minute
	}
	runCtx, cancel := context.WithTimeout(ctx, timeout)

	if opts.MaxTurns > 0 {
		b.cfg.Logger.Warn("ACP backend does not support --max-turns; ignoring",
			"agent", b.defaultExec, "maxTurns", opts.MaxTurns)
	}

	cmd := exec.CommandContext(runCtx, execPath, b.startArgs...)
	if opts.Cwd != "" {
		cmd.Dir = opts.Cwd
	}
	cmd.Env = buildEnv(b.cfg.Env)

	stdout, err := cmd.StdoutPipe()
	if err != nil {
		cancel()
		return nil, fmt.Errorf("%s stdout pipe: %w", b.defaultExec, err)
	}
	stdin, err := cmd.StdinPipe()
	if err != nil {
		cancel()
		return nil, fmt.Errorf("%s stdin pipe: %w", b.defaultExec, err)
	}
	logPrefix := fmt.Sprintf("[%s:stderr] ", b.defaultExec)
	cmd.Stderr = newLogWriter(b.cfg.Logger, logPrefix)

	if err := cmd.Start(); err != nil {
		cancel()
		return nil, fmt.Errorf("start %s: %w", b.defaultExec, err)
	}

	b.cfg.Logger.Info(b.defaultExec+" started", "pid", cmd.Process.Pid, "cwd", opts.Cwd, "model", opts.Model)

	msgCh := make(chan Message, 256)
	resCh := make(chan Result, 1)

	var outputMu sync.Mutex
	var output strings.Builder

	c := &acpClient{
		cfg:     b.cfg,
		stdin:   stdin,
		pending: make(map[int]*pendingRPC),
		onMessage: func(msg Message) {
			if msg.Type == MessageText {
				outputMu.Lock()
				output.WriteString(msg.Content)
				outputMu.Unlock()
			}
			trySend(msgCh, msg)
		},
	}

	// Read all stdout lines and dispatch to pending requests or notification handlers.
	readerDone := make(chan struct{})
	go func() {
		defer close(readerDone)
		scanner := bufio.NewScanner(stdout)
		scanner.Buffer(make([]byte, 0, 1024*1024), 10*1024*1024)
		for scanner.Scan() {
			line := strings.TrimSpace(scanner.Text())
			if line == "" {
				continue
			}
			c.handleLine(line)
		}
		c.closeAllPending(fmt.Errorf("%s process exited", b.defaultExec))
	}()

	// Drive the session lifecycle.
	// Shutdown sequence: lifecycle goroutine closes stdin + cancels context →
	// agent process exits → reader goroutine's scanner returns false →
	// readerDone closes → lifecycle goroutine collects output and sends Result.
	go func() {
		defer cancel()
		defer close(msgCh)
		defer close(resCh)
		defer func() {
			stdin.Close()
			_ = cmd.Wait()
		}()

		startTime := time.Now()
		finalStatus := "completed"
		var finalError string
		var finalSessionID string

		// 1. Initialize — capability handshake.
		_, err := c.request(runCtx, "initialize", map[string]any{
			"protocolVersion":    acpProtocolVersion,
			"clientCapabilities": map[string]any{},
			"clientInfo": map[string]any{
				"name":    "multica-agent-sdk",
				"title":   "Multica Agent SDK",
				"version": "0.2.0",
			},
		})
		if err != nil {
			finalStatus = "failed"
			finalError = fmt.Sprintf("%s initialize failed: %v", b.defaultExec, err)
			resCh <- Result{Status: finalStatus, Error: finalError, DurationMs: time.Since(startTime).Milliseconds()}
			return
		}

		// 2. Create or resume a session.
		sessionParams := map[string]any{
			"cwd":        opts.Cwd,
			"mcpServers": []any{},
		}
		sessionMethod := "session/new"
		if opts.ResumeSessionID != "" {
			sessionMethod = "session/load"
			sessionParams["sessionId"] = opts.ResumeSessionID
		}

		sessionResult, err := c.request(runCtx, sessionMethod, sessionParams)
		if err != nil {
			finalStatus = "failed"
			finalError = fmt.Sprintf("%s %s failed: %v", b.defaultExec, sessionMethod, err)
			resCh <- Result{Status: finalStatus, Error: finalError, DurationMs: time.Since(startTime).Milliseconds()}
			return
		}

		sessionID := extractACPSessionID(sessionResult)
		if sessionID == "" {
			finalStatus = "failed"
			finalError = fmt.Sprintf("%s %s returned no sessionId", b.defaultExec, sessionMethod)
			resCh <- Result{Status: finalStatus, Error: finalError, DurationMs: time.Since(startTime).Milliseconds()}
			return
		}
		c.sessionID = sessionID
		finalSessionID = sessionID
		b.cfg.Logger.Info(b.defaultExec+" session ready",
			"session_id", sessionID, "resumed", opts.ResumeSessionID != "")

		trySend(msgCh, Message{Type: MessageStatus, Status: "running"})

		// 3. Send prompt — blocks until the agent sends the final response.
		promptParams := map[string]any{
			"sessionId": sessionID,
			"prompt": []map[string]any{
				{"type": "text", "text": prompt},
			},
		}
		if opts.Model != "" {
			promptParams["model"] = opts.Model
		}
		if opts.SystemPrompt != "" {
			promptParams["systemPrompt"] = opts.SystemPrompt
		}

		_, err = c.request(runCtx, "session/prompt", promptParams)

		duration := time.Since(startTime)

		if err != nil {
			switch runCtx.Err() {
			case context.DeadlineExceeded:
				finalStatus = "timeout"
				finalError = fmt.Sprintf("%s timed out after %s", b.defaultExec, timeout)
			case context.Canceled:
				finalStatus = "aborted"
				finalError = "execution cancelled"
			default:
				finalStatus = "failed"
				finalError = fmt.Sprintf("%s session/prompt failed: %v", b.defaultExec, err)
			}
		}

		b.cfg.Logger.Info(b.defaultExec+" finished",
			"pid", cmd.Process.Pid, "status", finalStatus, "duration", duration.Round(time.Millisecond).String())

		// Signal the process to exit, then wait for the reader to drain.
		stdin.Close()
		cancel()
		<-readerDone

		outputMu.Lock()
		finalOutput := output.String()
		outputMu.Unlock()

		resCh <- Result{
			Status:     finalStatus,
			Output:     finalOutput,
			Error:      finalError,
			DurationMs: duration.Milliseconds(),
			SessionID:  finalSessionID,
		}
	}()

	return &Session{Messages: msgCh, Result: resCh}, nil
}

// ── ACP JSON-RPC 2.0 transport ──

const acpProtocolVersion = 1

// acpClient manages the ACP wire protocol (JSON-RPC 2.0 over stdin/stdout).
type acpClient struct {
	cfg          Config
	stdin        interface{ Write([]byte) (int, error) }
	mu           sync.Mutex
	nextID       int
	pending      map[int]*pendingRPC // reuses type from codex.go
	sessionID    string
	toolCallNames map[string]string // callID → toolName, for tool_call_update lookup
	onMessage    func(Message)
}

func (c *acpClient) request(ctx context.Context, method string, params any) (json.RawMessage, error) {
	c.mu.Lock()
	c.nextID++
	id := c.nextID
	pr := &pendingRPC{ch: make(chan rpcResult, 1), method: method}
	c.pending[id] = pr
	c.mu.Unlock()

	msg := map[string]any{
		"jsonrpc": "2.0",
		"id":      id,
		"method":  method,
		"params":  params,
	}
	data, err := json.Marshal(msg)
	if err != nil {
		c.mu.Lock()
		delete(c.pending, id)
		c.mu.Unlock()
		return nil, err
	}
	data = append(data, '\n')
	if _, err := c.stdin.Write(data); err != nil {
		c.mu.Lock()
		delete(c.pending, id)
		c.mu.Unlock()
		return nil, fmt.Errorf("write %s: %w", method, err)
	}

	select {
	case res := <-pr.ch:
		return res.result, res.err
	case <-ctx.Done():
		c.mu.Lock()
		delete(c.pending, id)
		c.mu.Unlock()
		return nil, ctx.Err()
	}
}

func (c *acpClient) respond(id int, result any) {
	msg := map[string]any{
		"jsonrpc": "2.0",
		"id":      id,
		"result":  result,
	}
	data, _ := json.Marshal(msg)
	data = append(data, '\n')
	_, _ = c.stdin.Write(data)
}

func (c *acpClient) closeAllPending(err error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	for id, pr := range c.pending {
		pr.ch <- rpcResult{err: err}
		delete(c.pending, id)
	}
}

func (c *acpClient) handleLine(line string) {
	var raw map[string]json.RawMessage
	if err := json.Unmarshal([]byte(line), &raw); err != nil {
		return
	}

	if _, hasID := raw["id"]; hasID {
		if _, hasResult := raw["result"]; hasResult {
			c.handleResponse(raw)
			return
		}
		if _, hasError := raw["error"]; hasError {
			c.handleResponse(raw)
			return
		}
		// Server-to-client request (has id + method).
		if _, hasMethod := raw["method"]; hasMethod {
			c.handleServerRequest(raw)
			return
		}
	}

	// Notification (no id, has method).
	if _, hasMethod := raw["method"]; hasMethod {
		c.handleNotification(raw)
	}
}

func (c *acpClient) handleResponse(raw map[string]json.RawMessage) {
	var id int
	if err := json.Unmarshal(raw["id"], &id); err != nil {
		return
	}

	c.mu.Lock()
	pr, ok := c.pending[id]
	if ok {
		delete(c.pending, id)
	}
	c.mu.Unlock()

	if !ok {
		return
	}

	if errData, hasErr := raw["error"]; hasErr {
		var rpcErr struct {
			Code    int    `json:"code"`
			Message string `json:"message"`
		}
		_ = json.Unmarshal(errData, &rpcErr)
		pr.ch <- rpcResult{err: fmt.Errorf("%s: %s (code=%d)", pr.method, rpcErr.Message, rpcErr.Code)}
	} else {
		pr.ch <- rpcResult{result: raw["result"]}
	}
}

// handleServerRequest handles requests sent from the agent to the client.
// In daemon mode all tool executions are auto-approved.
func (c *acpClient) handleServerRequest(raw map[string]json.RawMessage) {
	var id int
	_ = json.Unmarshal(raw["id"], &id)

	var method string
	_ = json.Unmarshal(raw["method"], &method)

	var params map[string]json.RawMessage
	if p, ok := raw["params"]; ok {
		_ = json.Unmarshal(p, &params)
	}

	switch method {
	case "session/request_permission":
		// Auto-approve in daemon mode: select the first available option.
		// ACP options have kind: allow_once | allow_always | reject_once | reject_always.
		// We prefer the first allow_* option; fall back to the very first option.
		outcome := map[string]any{"outcome": "cancelled"}
		if optionsRaw, ok := params["options"]; ok {
			var options []struct {
				OptionID string `json:"optionId"`
				Kind     string `json:"kind"`
			}
			if err := json.Unmarshal(optionsRaw, &options); err == nil && len(options) > 0 {
				chosen := options[0].OptionID
				for _, opt := range options {
					if opt.Kind == "allow_once" || opt.Kind == "allow_always" {
						chosen = opt.OptionID
						break
					}
				}
				outcome = map[string]any{
					"outcome":  "selected",
					"optionId": chosen,
				}
			}
		}
		c.respond(id, map[string]any{"outcome": outcome})
	default:
		c.respond(id, map[string]any{})
	}
}

// handleNotification handles agent-to-client notifications (no response needed).
func (c *acpClient) handleNotification(raw map[string]json.RawMessage) {
	var method string
	_ = json.Unmarshal(raw["method"], &method)

	if method != "session/update" {
		return
	}

	var params struct {
		SessionID string          `json:"sessionId"`
		Update    json.RawMessage `json:"update"`
	}
	if p, ok := raw["params"]; ok {
		_ = json.Unmarshal(p, &params)
	}
	if params.Update == nil {
		return
	}

	// ACP uses "sessionUpdate" as the discriminator field (snake_case type names).
	var header struct {
		SessionUpdate string `json:"sessionUpdate"`
	}
	if err := json.Unmarshal(params.Update, &header); err != nil {
		return
	}

	switch header.SessionUpdate {
	case "agent_message_chunk":
		c.handleAgentMessageChunk(params.Update)
	case "agent_thought_chunk":
		c.handleAgentThoughtChunk(params.Update)
	case "tool_call":
		c.handleToolCall(params.Update)
	case "tool_call_update":
		c.handleToolCallUpdate(params.Update)
	}
}

func (c *acpClient) handleAgentMessageChunk(data json.RawMessage) {
	var chunk struct {
		Content struct {
			Type string `json:"type"`
			Text string `json:"text"`
		} `json:"content"`
	}
	if err := json.Unmarshal(data, &chunk); err != nil || chunk.Content.Text == "" {
		return
	}
	if c.onMessage != nil {
		c.onMessage(Message{Type: MessageText, Content: chunk.Content.Text})
	}
}

func (c *acpClient) handleAgentThoughtChunk(data json.RawMessage) {
	var chunk struct {
		Content struct {
			Type string `json:"type"`
			Text string `json:"text"`
		} `json:"content"`
	}
	if err := json.Unmarshal(data, &chunk); err != nil || chunk.Content.Text == "" {
		return
	}
	if c.onMessage != nil {
		c.onMessage(Message{Type: MessageThinking, Content: chunk.Content.Text})
	}
}

// handleToolCall handles "tool_call" updates — the initial tool invocation announcement.
// Fields per ACP spec: id, toolName, input, timestamp.
func (c *acpClient) handleToolCall(data json.RawMessage) {
	var tc struct {
		ID       string          `json:"id"`
		ToolName string          `json:"toolName"`
		Input    json.RawMessage `json:"input"`
	}
	if err := json.Unmarshal(data, &tc); err != nil || c.onMessage == nil {
		return
	}

	// Record id → toolName so tool_call_update can resolve the name.
	if tc.ID != "" && tc.ToolName != "" {
		c.mu.Lock()
		if c.toolCallNames == nil {
			c.toolCallNames = make(map[string]string)
		}
		c.toolCallNames[tc.ID] = tc.ToolName
		c.mu.Unlock()
	}

	var input map[string]any
	if tc.Input != nil {
		_ = json.Unmarshal(tc.Input, &input)
	}
	c.onMessage(Message{
		Type:   MessageToolUse,
		Tool:   tc.ToolName,
		CallID: tc.ID,
		Input:  input,
	})
}

// handleToolCallUpdate handles "tool_call_update" — tool execution result.
// Fields per ACP spec: id (references tool_call), content (array of ContentBlocks).
func (c *acpClient) handleToolCallUpdate(data json.RawMessage) {
	var update struct {
		ID      string `json:"id"`
		Content []struct {
			Type string `json:"type"`
			Text string `json:"text"`
		} `json:"content"`
	}
	if err := json.Unmarshal(data, &update); err != nil || c.onMessage == nil {
		return
	}

	c.mu.Lock()
	toolName := c.toolCallNames[update.ID]
	c.mu.Unlock()

	// Concatenate all text content blocks into the output string.
	var sb strings.Builder
	for _, block := range update.Content {
		if block.Type == "text" && block.Text != "" {
			sb.WriteString(block.Text)
		}
	}

	c.onMessage(Message{
		Type:   MessageToolResult,
		Tool:   toolName,
		CallID: update.ID,
		Output: sb.String(),
	})
}

// extractACPSessionID extracts the sessionId field from a session/new response.
func extractACPSessionID(result json.RawMessage) string {
	var r struct {
		SessionID string `json:"sessionId"`
	}
	if err := json.Unmarshal(result, &r); err != nil {
		return ""
	}
	return r.SessionID
}
