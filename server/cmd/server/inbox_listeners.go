package main

import (
	"context"
	"log"

	"github.com/multica-ai/multica/server/internal/events"
	"github.com/multica-ai/multica/server/internal/handler"
	"github.com/multica-ai/multica/server/internal/util"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
	"github.com/multica-ai/multica/server/pkg/protocol"
)

// registerInboxListeners wires up event bus listeners that create inbox
// notifications. This replaces the inline CreateInboxItem calls that were
// previously scattered across issue and comment handlers.
func registerInboxListeners(bus *events.Bus, queries *db.Queries) {
	// issue:created — notify assignee about new assignment
	bus.Subscribe(protocol.EventIssueCreated, func(e events.Event) {
		payload, ok := e.Payload.(map[string]any)
		if !ok {
			return
		}
		issue, ok := payload["issue"].(handler.IssueResponse)
		if !ok {
			return
		}
		if issue.AssigneeType == nil || issue.AssigneeID == nil {
			return
		}

		item, err := queries.CreateInboxItem(context.Background(), db.CreateInboxItemParams{
			WorkspaceID:   parseUUID(issue.WorkspaceID),
			RecipientType: *issue.AssigneeType,
			RecipientID:   parseUUID(*issue.AssigneeID),
			Type:          "issue_assigned",
			Severity:      "action_required",
			IssueID:       parseUUID(issue.ID),
			Title:         "New issue assigned: " + issue.Title,
			Body:          util.PtrToText(issue.Description),
		})
		if err != nil {
			log.Printf("[inbox-listener] issue:created inbox error: %v", err)
			return
		}

		bus.Publish(events.Event{
			Type:        protocol.EventInboxNew,
			WorkspaceID: e.WorkspaceID,
			ActorType:   e.ActorType,
			ActorID:     e.ActorID,
			Payload:     map[string]any{"item": inboxItemToResponse(item)},
		})
	})

	// issue:updated — notify on assignee change and status change
	bus.Subscribe(protocol.EventIssueUpdated, func(e events.Event) {
		payload, ok := e.Payload.(map[string]any)
		if !ok {
			return
		}
		issue, ok := payload["issue"].(handler.IssueResponse)
		if !ok {
			return
		}
		assigneeChanged, _ := payload["assignee_changed"].(bool)
		statusChanged, _ := payload["status_changed"].(bool)
		prevAssigneeType, _ := payload["prev_assignee_type"].(*string)
		prevAssigneeID, _ := payload["prev_assignee_id"].(*string)
		creatorType, _ := payload["creator_type"].(string)
		creatorID, _ := payload["creator_id"].(string)

		actorID := e.ActorID // the user who made the change

		if assigneeChanged {
			// Notify old assignee about unassignment
			if prevAssigneeType != nil && prevAssigneeID != nil &&
				*prevAssigneeType == "member" && *prevAssigneeID != actorID {
				oldItem, err := queries.CreateInboxItem(context.Background(), db.CreateInboxItemParams{
					WorkspaceID:   parseUUID(e.WorkspaceID),
					RecipientType: "member",
					RecipientID:   parseUUID(*prevAssigneeID),
					Type:          "status_change",
					Severity:      "info",
					IssueID:       parseUUID(issue.ID),
					Title:         "Unassigned from: " + issue.Title,
				})
				if err == nil {
					bus.Publish(events.Event{
						Type:        protocol.EventInboxNew,
						WorkspaceID: e.WorkspaceID,
						ActorType:   e.ActorType,
						ActorID:     actorID,
						Payload:     map[string]any{"item": inboxItemToResponse(oldItem)},
					})
				}
			}

			// Notify new assignee about assignment
			if issue.AssigneeType != nil && issue.AssigneeID != nil {
				newItem, err := queries.CreateInboxItem(context.Background(), db.CreateInboxItemParams{
					WorkspaceID:   parseUUID(e.WorkspaceID),
					RecipientType: *issue.AssigneeType,
					RecipientID:   parseUUID(*issue.AssigneeID),
					Type:          "issue_assigned",
					Severity:      "action_required",
					IssueID:       parseUUID(issue.ID),
					Title:         "Assigned to you: " + issue.Title,
				})
				if err == nil {
					bus.Publish(events.Event{
						Type:        protocol.EventInboxNew,
						WorkspaceID: e.WorkspaceID,
						ActorType:   e.ActorType,
						ActorID:     actorID,
						Payload:     map[string]any{"item": inboxItemToResponse(newItem)},
					})
				}
			}
		}

		if statusChanged {
			// Notify assignee about status change
			if issue.AssigneeType != nil && issue.AssigneeID != nil {
				aItem, err := queries.CreateInboxItem(context.Background(), db.CreateInboxItemParams{
					WorkspaceID:   parseUUID(e.WorkspaceID),
					RecipientType: *issue.AssigneeType,
					RecipientID:   parseUUID(*issue.AssigneeID),
					Type:          "status_change",
					Severity:      "info",
					IssueID:       parseUUID(issue.ID),
					Title:         issue.Title + " moved to " + issue.Status,
				})
				if err == nil {
					bus.Publish(events.Event{
						Type:        protocol.EventInboxNew,
						WorkspaceID: e.WorkspaceID,
						ActorType:   e.ActorType,
						ActorID:     actorID,
						Payload:     map[string]any{"item": inboxItemToResponse(aItem)},
					})
				}
			}

			// Notify creator about status change (if creator is member and != the person making change)
			if creatorType == "member" && creatorID != actorID {
				// Don't double-notify if creator is also the assignee
				isAlsoAssignee := prevAssigneeID != nil && *prevAssigneeID == creatorID
				if !isAlsoAssignee {
					cItem, err := queries.CreateInboxItem(context.Background(), db.CreateInboxItemParams{
						WorkspaceID:   parseUUID(e.WorkspaceID),
						RecipientType: "member",
						RecipientID:   parseUUID(creatorID),
						Type:          "status_change",
						Severity:      "info",
						IssueID:       parseUUID(issue.ID),
						Title:         "Status changed: " + issue.Title,
					})
					if err == nil {
						bus.Publish(events.Event{
							Type:        protocol.EventInboxNew,
							WorkspaceID: e.WorkspaceID,
							ActorType:   e.ActorType,
							ActorID:     actorID,
							Payload:     map[string]any{"item": inboxItemToResponse(cItem)},
						})
					}
				}
			}
		}
	})

	// comment:created — notify issue assignee about new comment
	bus.Subscribe(protocol.EventCommentCreated, func(e events.Event) {
		payload, ok := e.Payload.(map[string]any)
		if !ok {
			return
		}
		comment, ok := payload["comment"].(handler.CommentResponse)
		if !ok {
			return
		}
		issueTitle, _ := payload["issue_title"].(string)
		issueAssigneeType, _ := payload["issue_assignee_type"].(*string)
		issueAssigneeID, _ := payload["issue_assignee_id"].(*string)

		// Only notify if assignee is a member and is not the commenter
		if issueAssigneeType == nil || issueAssigneeID == nil {
			return
		}
		if *issueAssigneeType != "member" || *issueAssigneeID == e.ActorID {
			return
		}

		item, err := queries.CreateInboxItem(context.Background(), db.CreateInboxItemParams{
			WorkspaceID:   parseUUID(e.WorkspaceID),
			RecipientType: "member",
			RecipientID:   parseUUID(*issueAssigneeID),
			Type:          "mentioned",
			Severity:      "info",
			IssueID:       parseUUID(comment.IssueID),
			Title:         "New comment on: " + issueTitle,
			Body:          util.StrToText(comment.Content),
		})
		if err != nil {
			log.Printf("[inbox-listener] comment:created inbox error: %v", err)
			return
		}

		bus.Publish(events.Event{
			Type:        protocol.EventInboxNew,
			WorkspaceID: e.WorkspaceID,
			ActorType:   e.ActorType,
			ActorID:     e.ActorID,
			Payload:     map[string]any{"item": inboxItemToResponse(item)},
		})
	})
}

// inboxItemToResponse converts a db.InboxItem into a map suitable for
// JSON-serializable event payloads (mirrors handler.inboxToResponse fields).
func inboxItemToResponse(item db.InboxItem) map[string]any {
	return map[string]any{
		"id":             util.UUIDToString(item.ID),
		"workspace_id":   util.UUIDToString(item.WorkspaceID),
		"recipient_type": item.RecipientType,
		"recipient_id":   util.UUIDToString(item.RecipientID),
		"type":           item.Type,
		"severity":       item.Severity,
		"issue_id":       util.UUIDToPtr(item.IssueID),
		"title":          item.Title,
		"body":           util.TextToPtr(item.Body),
		"read":           item.Read,
		"archived":       item.Archived,
		"created_at":     util.TimestampToString(item.CreatedAt),
	}
}
