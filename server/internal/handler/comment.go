package handler

import (
	"encoding/json"
	"net/http"

	"github.com/go-chi/chi/v5"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
	"github.com/multica-ai/multica/server/pkg/protocol"
)

type CommentResponse struct {
	ID         string `json:"id"`
	IssueID    string `json:"issue_id"`
	AuthorType string `json:"author_type"`
	AuthorID   string `json:"author_id"`
	Content    string `json:"content"`
	Type       string `json:"type"`
	CreatedAt  string `json:"created_at"`
	UpdatedAt  string `json:"updated_at"`
}

func commentToResponse(c db.Comment) CommentResponse {
	return CommentResponse{
		ID:         uuidToString(c.ID),
		IssueID:    uuidToString(c.IssueID),
		AuthorType: c.AuthorType,
		AuthorID:   uuidToString(c.AuthorID),
		Content:    c.Content,
		Type:       c.Type,
		CreatedAt:  timestampToString(c.CreatedAt),
		UpdatedAt:  timestampToString(c.UpdatedAt),
	}
}

func (h *Handler) ListComments(w http.ResponseWriter, r *http.Request) {
	issueID := chi.URLParam(r, "id")
	issue, ok := h.loadIssueForUser(w, r, issueID)
	if !ok {
		return
	}

	comments, err := h.Queries.ListComments(r.Context(), issue.ID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to list comments")
		return
	}

	resp := make([]CommentResponse, len(comments))
	for i, c := range comments {
		resp[i] = commentToResponse(c)
	}

	writeJSON(w, http.StatusOK, resp)
}

type CreateCommentRequest struct {
	Content string `json:"content"`
	Type    string `json:"type"`
}

func (h *Handler) CreateComment(w http.ResponseWriter, r *http.Request) {
	issueID := chi.URLParam(r, "id")
	issue, ok := h.loadIssueForUser(w, r, issueID)
	if !ok {
		return
	}

	userID, ok := requireUserID(w, r)
	if !ok {
		return
	}

	var req CreateCommentRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}

	if req.Content == "" {
		writeError(w, http.StatusBadRequest, "content is required")
		return
	}
	if req.Type == "" {
		req.Type = "comment"
	}

	comment, err := h.Queries.CreateComment(r.Context(), db.CreateCommentParams{
		IssueID:    issue.ID,
		AuthorType: "member",
		AuthorID:   parseUUID(userID),
		Content:    req.Content,
		Type:       req.Type,
	})
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to create comment: "+err.Error())
		return
	}

	resp := commentToResponse(comment)
	h.publish(protocol.EventCommentCreated, uuidToString(issue.WorkspaceID), "member", userID, map[string]any{
		"comment":              resp,
		"issue_title":          issue.Title,
		"issue_assignee_type":  textToPtr(issue.AssigneeType),
		"issue_assignee_id":    uuidToPtr(issue.AssigneeID),
	})

	writeJSON(w, http.StatusCreated, resp)
}

func (h *Handler) UpdateComment(w http.ResponseWriter, r *http.Request) {
	commentId := chi.URLParam(r, "commentId")

	userID, ok := requireUserID(w, r)
	if !ok {
		return
	}

	// Load comment to check ownership
	existing, err := h.Queries.GetComment(r.Context(), parseUUID(commentId))
	if err != nil {
		writeError(w, http.StatusNotFound, "comment not found")
		return
	}

	// Load issue to get workspace
	issue, err := h.Queries.GetIssue(r.Context(), existing.IssueID)
	if err != nil {
		writeError(w, http.StatusNotFound, "comment not found")
		return
	}

	member, ok := h.requireWorkspaceMember(w, r, uuidToString(issue.WorkspaceID), "comment not found")
	if !ok {
		return
	}

	isAuthor := existing.AuthorType == "member" && uuidToString(existing.AuthorID) == userID
	isAdmin := roleAllowed(member.Role, "owner", "admin")
	if !isAuthor && !isAdmin {
		writeError(w, http.StatusForbidden, "only comment author or admin can edit")
		return
	}

	var req struct {
		Content string `json:"content"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	if req.Content == "" {
		writeError(w, http.StatusBadRequest, "content is required")
		return
	}

	comment, err := h.Queries.UpdateComment(r.Context(), db.UpdateCommentParams{
		ID:      parseUUID(commentId),
		Content: req.Content,
	})
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to update comment")
		return
	}

	resp := commentToResponse(comment)
	h.publish(protocol.EventCommentUpdated, uuidToString(issue.WorkspaceID), "member", userID, map[string]any{"comment": resp})
	writeJSON(w, http.StatusOK, resp)
}

func (h *Handler) DeleteComment(w http.ResponseWriter, r *http.Request) {
	commentId := chi.URLParam(r, "commentId")

	userID, ok := requireUserID(w, r)
	if !ok {
		return
	}

	// Get the comment first to know the issue_id for the broadcast
	comment, err := h.Queries.GetComment(r.Context(), parseUUID(commentId))
	if err != nil {
		writeError(w, http.StatusNotFound, "comment not found")
		return
	}

	// Load issue to get workspace
	issue, err := h.Queries.GetIssue(r.Context(), comment.IssueID)
	if err != nil {
		writeError(w, http.StatusNotFound, "comment not found")
		return
	}

	member, ok := h.requireWorkspaceMember(w, r, uuidToString(issue.WorkspaceID), "comment not found")
	if !ok {
		return
	}

	isAuthor := comment.AuthorType == "member" && uuidToString(comment.AuthorID) == userID
	isAdmin := roleAllowed(member.Role, "owner", "admin")
	if !isAuthor && !isAdmin {
		writeError(w, http.StatusForbidden, "only comment author or admin can delete")
		return
	}

	if err := h.Queries.DeleteComment(r.Context(), parseUUID(commentId)); err != nil {
		writeError(w, http.StatusInternalServerError, "failed to delete comment")
		return
	}

	h.publish(protocol.EventCommentDeleted, uuidToString(issue.WorkspaceID), "member", userID, map[string]any{
		"comment_id": commentId,
		"issue_id":   uuidToString(comment.IssueID),
	})
	w.WriteHeader(http.StatusNoContent)
}
