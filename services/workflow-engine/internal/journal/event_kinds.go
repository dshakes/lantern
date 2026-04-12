package journal

// Journal event kinds. These are the canonical set of events that can appear
// in the journal_events table. Every state transition in a run's lifecycle is
// represented by one of these kinds.
const (
	KindRunStarted        = "run_started"
	KindStepStarted       = "step_started"
	KindStepCompleted     = "step_completed"
	KindStepFailed        = "step_failed"
	KindSignalReceived    = "signal_received"
	KindSignalWaiting     = "signal_waiting"
	KindSleepStarted      = "sleep_started"
	KindSleepCompleted    = "sleep_completed"
	KindApprovalRequested = "approval_requested"
	KindApprovalGranted   = "approval_granted"
	KindApprovalDenied    = "approval_denied"
	KindRunSucceeded      = "run_succeeded"
	KindRunFailed         = "run_failed"
	KindRunCancelled      = "run_cancelled"
	KindChildStarted      = "child_started"
	KindChildCompleted    = "child_completed"
)
