package engine

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	"github.com/redis/go-redis/v9"
	"go.uber.org/zap"
)

const (
	// streamChannelPrefix is the Redis pub/sub channel prefix for run events.
	streamChannelPrefix = "lantern:run:stream:"

	// streamBacklogPrefix is the Redis list prefix for buffered events that
	// support reconnection. Events are stored with a TTL so they don't
	// accumulate forever.
	streamBacklogPrefix = "lantern:run:backlog:"

	// streamBacklogTTL is how long buffered events are retained for reconnect.
	streamBacklogTTL = 30 * time.Minute

	// streamBacklogMaxLen caps the backlog list to prevent unbounded growth
	// for long-running runs with slow subscribers.
	streamBacklogMaxLen = 10000
)

// StreamEvent is the envelope published to Redis for each notable event
// during a run's execution. Subscribers (the gateway SSE endpoint) listen
// on the pub/sub channel and read the backlog for reconnect.
type StreamEvent struct {
	RunID   string          `json:"run_id"`
	StepID  string          `json:"step_id,omitempty"`
	Seq     int64           `json:"seq"`
	Kind    string          `json:"kind"`
	Payload json.RawMessage `json:"payload,omitempty"`
	TS      time.Time       `json:"ts"`
}

// EventStreamer publishes run events to Redis for real-time consumption by
// the API gateway's SSE endpoint.
type EventStreamer struct {
	rdb    *redis.Client
	logger *zap.Logger
}

// NewEventStreamer creates a new EventStreamer.
func NewEventStreamer(rdb *redis.Client, logger *zap.Logger) *EventStreamer {
	return &EventStreamer{
		rdb:    rdb,
		logger: logger.Named("event_streamer"),
	}
}

// Publish sends an event to both the pub/sub channel (for live subscribers)
// and the backlog list (for reconnect support). Errors are logged but do not
// fail the run — streaming is best-effort from the engine's perspective.
func (es *EventStreamer) Publish(ctx context.Context, event *StreamEvent) {
	data, err := json.Marshal(event)
	if err != nil {
		es.logger.Error("failed to marshal stream event",
			zap.String("run_id", event.RunID),
			zap.Error(err),
		)
		return
	}

	channel := streamChannelPrefix + event.RunID
	backlogKey := streamBacklogPrefix + event.RunID

	// Publish to pub/sub for live subscribers.
	if err := es.rdb.Publish(ctx, channel, data).Err(); err != nil {
		es.logger.Warn("failed to publish stream event",
			zap.String("run_id", event.RunID),
			zap.String("channel", channel),
			zap.Error(err),
		)
	}

	// Append to backlog list for reconnect support.
	pipe := es.rdb.Pipeline()
	pipe.RPush(ctx, backlogKey, data)
	pipe.LTrim(ctx, backlogKey, -streamBacklogMaxLen, -1)
	pipe.Expire(ctx, backlogKey, streamBacklogTTL)
	if _, err := pipe.Exec(ctx); err != nil {
		es.logger.Warn("failed to append to stream backlog",
			zap.String("run_id", event.RunID),
			zap.Error(err),
		)
	}
}

// Subscribe returns a channel that receives stream events for the given run.
// The caller must cancel the context to unsubscribe. If fromSeq > 0, events
// from the backlog with seq >= fromSeq are replayed first before switching
// to live pub/sub.
func (es *EventStreamer) Subscribe(ctx context.Context, runID string, fromSeq int64) (<-chan *StreamEvent, error) {
	out := make(chan *StreamEvent, 256)

	// If the caller wants to resume from a specific sequence, replay from backlog first.
	if fromSeq > 0 {
		backlogKey := streamBacklogPrefix + runID
		entries, err := es.rdb.LRange(ctx, backlogKey, 0, -1).Result()
		if err != nil && err != redis.Nil {
			return nil, fmt.Errorf("failed to read backlog: %w", err)
		}
		for _, raw := range entries {
			var event StreamEvent
			if json.Unmarshal([]byte(raw), &event) != nil {
				continue
			}
			if event.Seq >= fromSeq {
				select {
				case out <- &event:
				case <-ctx.Done():
					close(out)
					return out, ctx.Err()
				}
			}
		}
	}

	// Subscribe to live pub/sub.
	channel := streamChannelPrefix + runID
	pubsub := es.rdb.Subscribe(ctx, channel)

	go func() {
		defer close(out)
		defer pubsub.Close() //nolint:errcheck

		ch := pubsub.Channel()
		for {
			select {
			case <-ctx.Done():
				return
			case msg, ok := <-ch:
				if !ok {
					return
				}
				var event StreamEvent
				if json.Unmarshal([]byte(msg.Payload), &event) != nil {
					continue
				}
				select {
				case out <- &event:
				case <-ctx.Done():
					return
				}
			}
		}
	}()

	return out, nil
}

// PublishEnd sends a terminal event signaling that the stream for this run
// is complete. Subscribers should close their connections after receiving this.
func (es *EventStreamer) PublishEnd(ctx context.Context, runID string, seq int64, reason string) {
	payload, _ := json.Marshal(map[string]string{"reason": reason})
	es.Publish(ctx, &StreamEvent{
		RunID:   runID,
		Seq:     seq,
		Kind:    "stream_end",
		Payload: payload,
		TS:      time.Now().UTC(),
	})
}
