package handler

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"strconv"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5/pgtype"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
	"github.com/multica-ai/multica/server/pkg/protocol"
)

// IssueResponse is the JSON response for an issue.
type IssueResponse struct {
	ID                 string  `json:"id"`
	WorkspaceID        string  `json:"workspace_id"`
	Title              string  `json:"title"`
	Description        *string `json:"description"`
	Status             string  `json:"status"`
	Priority           string  `json:"priority"`
	AssigneeType       *string `json:"assignee_type"`
	AssigneeID         *string `json:"assignee_id"`
	CreatorType        string  `json:"creator_type"`
	CreatorID          string  `json:"creator_id"`
	ParentIssueID      *string `json:"parent_issue_id"`
	AcceptanceCriteria []any   `json:"acceptance_criteria"`
	ContextRefs        []any   `json:"context_refs"`
	Position           float64 `json:"position"`
	DueDate            *string `json:"due_date"`
	CreatedAt          string  `json:"created_at"`
	UpdatedAt          string  `json:"updated_at"`
}

type agentTriggerSnapshot struct {
	Type    string         `json:"type"`
	Enabled bool           `json:"enabled"`
	Config  map[string]any `json:"config"`
}

func issueToResponse(i db.Issue) IssueResponse {
	var ac []any
	if i.AcceptanceCriteria != nil {
		json.Unmarshal(i.AcceptanceCriteria, &ac)
	}
	if ac == nil {
		ac = []any{}
	}

	var cr []any
	if i.ContextRefs != nil {
		json.Unmarshal(i.ContextRefs, &cr)
	}
	if cr == nil {
		cr = []any{}
	}

	return IssueResponse{
		ID:                 uuidToString(i.ID),
		WorkspaceID:        uuidToString(i.WorkspaceID),
		Title:              i.Title,
		Description:        textToPtr(i.Description),
		Status:             i.Status,
		Priority:           i.Priority,
		AssigneeType:       textToPtr(i.AssigneeType),
		AssigneeID:         uuidToPtr(i.AssigneeID),
		CreatorType:        i.CreatorType,
		CreatorID:          uuidToString(i.CreatorID),
		ParentIssueID:      uuidToPtr(i.ParentIssueID),
		AcceptanceCriteria: ac,
		ContextRefs:        cr,
		Position:           i.Position,
		DueDate:            timestampToPtr(i.DueDate),
		CreatedAt:          timestampToString(i.CreatedAt),
		UpdatedAt:          timestampToString(i.UpdatedAt),
	}
}

func (h *Handler) ListIssues(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()

	workspaceID := resolveWorkspaceID(r)
	if _, ok := h.requireWorkspaceMember(w, r, workspaceID, "workspace not found"); !ok {
		return
	}

	limit := 100
	offset := 0
	if l := r.URL.Query().Get("limit"); l != "" {
		if v, err := strconv.Atoi(l); err == nil {
			limit = v
		}
	}
	if o := r.URL.Query().Get("offset"); o != "" {
		if v, err := strconv.Atoi(o); err == nil {
			offset = v
		}
	}

	// Parse optional filter params
	var statusFilter pgtype.Text
	if s := r.URL.Query().Get("status"); s != "" {
		statusFilter = pgtype.Text{String: s, Valid: true}
	}
	var priorityFilter pgtype.Text
	if p := r.URL.Query().Get("priority"); p != "" {
		priorityFilter = pgtype.Text{String: p, Valid: true}
	}
	var assigneeFilter pgtype.UUID
	if a := r.URL.Query().Get("assignee_id"); a != "" {
		assigneeFilter = parseUUID(a)
	}

	issues, err := h.Queries.ListIssues(ctx, db.ListIssuesParams{
		WorkspaceID: parseUUID(workspaceID),
		Limit:       int32(limit),
		Offset:      int32(offset),
		Status:      statusFilter,
		Priority:    priorityFilter,
		AssigneeID:  assigneeFilter,
	})
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to list issues")
		return
	}

	resp := make([]IssueResponse, len(issues))
	for i, issue := range issues {
		resp[i] = issueToResponse(issue)
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"issues": resp,
		"total":  len(resp),
	})
}

func (h *Handler) GetIssue(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	issue, ok := h.loadIssueForUser(w, r, id)
	if !ok {
		return
	}
	writeJSON(w, http.StatusOK, issueToResponse(issue))
}

type CreateIssueRequest struct {
	Title              string  `json:"title"`
	Description        *string `json:"description"`
	Status             string  `json:"status"`
	Priority           string  `json:"priority"`
	AssigneeType       *string `json:"assignee_type"`
	AssigneeID         *string `json:"assignee_id"`
	ParentIssueID      *string `json:"parent_issue_id"`
	AcceptanceCriteria []any   `json:"acceptance_criteria"`
	ContextRefs        []any   `json:"context_refs"`
}

func (h *Handler) CreateIssue(w http.ResponseWriter, r *http.Request) {
	var req CreateIssueRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}

	if req.Title == "" {
		writeError(w, http.StatusBadRequest, "title is required")
		return
	}

	workspaceID := resolveWorkspaceID(r)
	if _, ok := h.requireWorkspaceMember(w, r, workspaceID, "workspace not found"); !ok {
		return
	}

	// Get creator from context (set by auth middleware)
	creatorID, ok := requireUserID(w, r)
	if !ok {
		return
	}

	status := req.Status
	if status == "" {
		status = "backlog"
	}
	priority := req.Priority
	if priority == "" {
		priority = "none"
	}

	ac, _ := json.Marshal(req.AcceptanceCriteria)
	if req.AcceptanceCriteria == nil {
		ac = []byte("[]")
	}
	cr, _ := json.Marshal(req.ContextRefs)
	if req.ContextRefs == nil {
		cr = []byte("[]")
	}
	var assigneeType pgtype.Text
	var assigneeID pgtype.UUID
	if req.AssigneeType != nil {
		assigneeType = pgtype.Text{String: *req.AssigneeType, Valid: true}
	}
	if req.AssigneeID != nil {
		assigneeID = parseUUID(*req.AssigneeID)
	}

	var parentIssueID pgtype.UUID
	if req.ParentIssueID != nil {
		parentIssueID = parseUUID(*req.ParentIssueID)
	}

	issue, err := h.Queries.CreateIssue(r.Context(), db.CreateIssueParams{
		WorkspaceID:        parseUUID(workspaceID),
		Title:              req.Title,
		Description:        ptrToText(req.Description),
		Status:             status,
		Priority:           priority,
		AssigneeType:       assigneeType,
		AssigneeID:         assigneeID,
		CreatorType:        "member",
		CreatorID:          parseUUID(creatorID),
		ParentIssueID:      parentIssueID,
		AcceptanceCriteria: ac,
		ContextRefs:        cr,
		Position:           0,
	})
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to create issue: "+err.Error())
		return
	}

	resp := issueToResponse(issue)
	h.publish(protocol.EventIssueCreated, workspaceID, "member", creatorID, map[string]any{"issue": resp})

	// Only ready issues in todo are enqueued for agents.
	if issue.AssigneeType.Valid && issue.AssigneeID.Valid {
		if h.shouldEnqueueAgentTask(r.Context(), issue) {
			h.TaskService.EnqueueTaskForIssue(r.Context(), issue)
		}
	}

	writeJSON(w, http.StatusCreated, resp)
}

type UpdateIssueRequest struct {
	Title              *string  `json:"title"`
	Description        *string  `json:"description"`
	Status             *string  `json:"status"`
	Priority           *string  `json:"priority"`
	AssigneeType       *string  `json:"assignee_type"`
	AssigneeID         *string  `json:"assignee_id"`
	Position           *float64 `json:"position"`
	DueDate            *string  `json:"due_date"`
	AcceptanceCriteria *[]any   `json:"acceptance_criteria"`
	ContextRefs        *[]any   `json:"context_refs"`
}

func (h *Handler) UpdateIssue(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	prevIssue, ok := h.loadIssueForUser(w, r, id)
	if !ok {
		return
	}
	userID := requestUserID(r)
	workspaceID := uuidToString(prevIssue.WorkspaceID)

	// Read body as raw bytes so we can detect which fields were explicitly sent.
	bodyBytes, err := io.ReadAll(r.Body)
	if err != nil {
		writeError(w, http.StatusBadRequest, "failed to read request body")
		return
	}

	var req UpdateIssueRequest
	if err := json.Unmarshal(bodyBytes, &req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}

	// Track which fields were explicitly present in JSON (even if null)
	var rawFields map[string]json.RawMessage
	json.Unmarshal(bodyBytes, &rawFields)

	// Pre-fill nullable fields (bare sqlc.narg) with current values
	params := db.UpdateIssueParams{
		ID:           prevIssue.ID,
		AssigneeType: prevIssue.AssigneeType,
		AssigneeID:   prevIssue.AssigneeID,
		DueDate:      prevIssue.DueDate,
	}

	// COALESCE fields — only set when explicitly provided
	if req.Title != nil {
		params.Title = pgtype.Text{String: *req.Title, Valid: true}
	}
	if req.Description != nil {
		params.Description = pgtype.Text{String: *req.Description, Valid: true}
	}
	if req.Status != nil {
		params.Status = pgtype.Text{String: *req.Status, Valid: true}
	}
	if req.Priority != nil {
		params.Priority = pgtype.Text{String: *req.Priority, Valid: true}
	}
	if req.Position != nil {
		params.Position = pgtype.Float8{Float64: *req.Position, Valid: true}
	}
	if req.AcceptanceCriteria != nil {
		ac, _ := json.Marshal(*req.AcceptanceCriteria)
		params.AcceptanceCriteria = ac
	}
	if req.ContextRefs != nil {
		cr, _ := json.Marshal(*req.ContextRefs)
		params.ContextRefs = cr
	}

	// Nullable fields — only override when explicitly present in JSON
	if _, ok := rawFields["assignee_type"]; ok {
		if req.AssigneeType != nil {
			params.AssigneeType = pgtype.Text{String: *req.AssigneeType, Valid: true}
		} else {
			params.AssigneeType = pgtype.Text{Valid: false} // explicit null = unassign
		}
	}
	if _, ok := rawFields["assignee_id"]; ok {
		if req.AssigneeID != nil {
			params.AssigneeID = parseUUID(*req.AssigneeID)
		} else {
			params.AssigneeID = pgtype.UUID{Valid: false} // explicit null = unassign
		}
	}
	if _, ok := rawFields["due_date"]; ok {
		if req.DueDate != nil && *req.DueDate != "" {
			t, err := time.Parse(time.RFC3339, *req.DueDate)
			if err != nil {
				writeError(w, http.StatusBadRequest, "invalid due_date format, expected RFC3339")
				return
			}
			params.DueDate = pgtype.Timestamptz{Time: t, Valid: true}
		} else {
			params.DueDate = pgtype.Timestamptz{Valid: false} // explicit null = clear date
		}
	}

	issue, err := h.Queries.UpdateIssue(r.Context(), params)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to update issue: "+err.Error())
		return
	}

	resp := issueToResponse(issue)

	assigneeChanged := (req.AssigneeType != nil || req.AssigneeID != nil) &&
		(prevIssue.AssigneeType.String != issue.AssigneeType.String || uuidToString(prevIssue.AssigneeID) != uuidToString(issue.AssigneeID))
	statusChanged := req.Status != nil && prevIssue.Status != issue.Status

	h.publish(protocol.EventIssueUpdated, workspaceID, "member", userID, map[string]any{
		"issue":              resp,
		"assignee_changed":   assigneeChanged,
		"status_changed":     statusChanged,
		"prev_assignee_type": textToPtr(prevIssue.AssigneeType),
		"prev_assignee_id":   uuidToPtr(prevIssue.AssigneeID),
		"prev_status":        prevIssue.Status,
		"creator_type":       prevIssue.CreatorType,
		"creator_id":         uuidToString(prevIssue.CreatorID),
	})

	// If assignee or readiness status changed, reconcile the task queue.
	if assigneeChanged || statusChanged {
		h.TaskService.CancelTasksForIssue(r.Context(), issue.ID)

		if h.shouldEnqueueAgentTask(r.Context(), issue) {
			h.TaskService.EnqueueTaskForIssue(r.Context(), issue)
		}
	}

	writeJSON(w, http.StatusOK, resp)
}

func (h *Handler) shouldEnqueueAgentTask(ctx context.Context, issue db.Issue) bool {
	if issue.Status != "todo" {
		return false
	}
	if !issue.AssigneeType.Valid || issue.AssigneeType.String != "agent" || !issue.AssigneeID.Valid {
		return false
	}

	agent, err := h.Queries.GetAgent(ctx, issue.AssigneeID)
	if err != nil || !agent.RuntimeID.Valid {
		return false
	}
	if agent.Triggers == nil || len(agent.Triggers) == 0 {
		return true
	}

	var triggers []agentTriggerSnapshot
	if err := json.Unmarshal(agent.Triggers, &triggers); err != nil {
		return false
	}
	for _, trigger := range triggers {
		if trigger.Type == "on_assign" && trigger.Enabled {
			return true
		}
	}
	return false
}

func (h *Handler) DeleteIssue(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	issue, ok := h.loadIssueForUser(w, r, id)
	if !ok {
		return
	}

	h.TaskService.CancelTasksForIssue(r.Context(), issue.ID)

	err := h.Queries.DeleteIssue(r.Context(), parseUUID(id))
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to delete issue")
		return
	}

	userID := requestUserID(r)
	h.publish(protocol.EventIssueDeleted, uuidToString(issue.WorkspaceID), "member", userID, map[string]any{"issue_id": id})
	w.WriteHeader(http.StatusNoContent)
}
