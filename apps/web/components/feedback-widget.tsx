"use client";

import { useState } from "react";
import { ThumbsUp, ThumbsDown, Loader2, Check, MessageSquare } from "lucide-react";
import { api } from "@/lib/api";
import { useToast } from "@/components/toast";

interface FeedbackWidgetProps {
  runId: string;
  source?: "dashboard" | "sdk" | "surface";
}

export function FeedbackWidget({ runId, source = "dashboard" }: FeedbackWidgetProps) {
  const toast = useToast();
  const [submitted, setSubmitted] = useState<null | "up" | "down">(null);
  const [submitting, setSubmitting] = useState(false);
  const [showDetail, setShowDetail] = useState(false);
  const [comment, setComment] = useState("");
  const [preferredOutput, setPreferredOutput] = useState("");

  const submitScore = async (score: number, choice: "up" | "down") => {
    setSubmitting(true);
    try {
      await api.submitRunFeedback(runId, { score, source });
      setSubmitted(choice);
      toast.success(choice === "up" ? "Thanks for the thumbs up" : "Thanks — we'll learn from this");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to record feedback");
    } finally {
      setSubmitting(false);
    }
  };

  const submitDetailed = async () => {
    if (!submitted) return;
    setSubmitting(true);
    try {
      await api.submitRunFeedback(runId, {
        score: submitted === "up" ? 5 : 1,
        comment: comment || undefined,
        preferredOutput: preferredOutput || undefined,
        source,
      });
      toast.success("Detailed feedback recorded");
      setShowDetail(false);
      setComment("");
      setPreferredOutput("");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to record feedback");
    } finally {
      setSubmitting(false);
    }
  };

  if (submitted && !showDetail) {
    return (
      <div className="flex items-center justify-between rounded-lg border border-zinc-800 bg-surface-2/50 px-4 py-3">
        <div className="flex items-center gap-2 text-xs text-zinc-400">
          <Check className="h-3.5 w-3.5 text-emerald-400" />
          Feedback recorded
        </div>
        <button
          onClick={() => setShowDetail(true)}
          className="inline-flex items-center gap-1.5 text-xs text-zinc-500 transition-colors hover:text-zinc-300"
        >
          <MessageSquare className="h-3 w-3" />
          Add detail
        </button>
      </div>
    );
  }

  if (showDetail) {
    return (
      <div className="space-y-3 rounded-lg border border-zinc-800 bg-surface-2/50 p-4">
        <div className="text-xs font-medium uppercase tracking-wider text-zinc-500">
          What would have been better?
        </div>
        <textarea
          value={comment}
          onChange={(e) => setComment(e.target.value)}
          placeholder="What was wrong (or right) about this run?"
          rows={2}
          className="w-full rounded-md border border-zinc-800 bg-surface-1 px-3 py-2 text-sm text-zinc-200 placeholder:text-zinc-600 focus:border-lantern-500/50 focus:outline-none"
        />
        <textarea
          value={preferredOutput}
          onChange={(e) => setPreferredOutput(e.target.value)}
          placeholder="Optional: paste the output you would have preferred"
          rows={3}
          className="w-full rounded-md border border-zinc-800 bg-surface-1 px-3 py-2 font-mono text-xs text-zinc-200 placeholder:text-zinc-600 focus:border-lantern-500/50 focus:outline-none"
        />
        <div className="flex items-center justify-end gap-2">
          <button
            onClick={() => setShowDetail(false)}
            className="rounded-md px-3 py-1.5 text-xs text-zinc-400 transition-colors hover:text-zinc-200"
          >
            Cancel
          </button>
          <button
            onClick={submitDetailed}
            disabled={submitting}
            className="inline-flex items-center gap-1.5 rounded-md bg-lantern-500 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-lantern-400 disabled:opacity-50"
          >
            {submitting ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
            Submit
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex items-center justify-between rounded-lg border border-zinc-800 bg-surface-2/50 px-4 py-3">
      <div className="text-xs text-zinc-500">Was this run useful?</div>
      <div className="flex items-center gap-1">
        <button
          onClick={() => submitScore(5, "up")}
          disabled={submitting}
          aria-label="Thumbs up"
          className="rounded-md p-1.5 text-zinc-500 transition-colors hover:bg-emerald-500/10 hover:text-emerald-400 disabled:opacity-50"
        >
          <ThumbsUp className="h-3.5 w-3.5" />
        </button>
        <button
          onClick={() => submitScore(1, "down")}
          disabled={submitting}
          aria-label="Thumbs down"
          className="rounded-md p-1.5 text-zinc-500 transition-colors hover:bg-red-500/10 hover:text-red-400 disabled:opacity-50"
        >
          <ThumbsDown className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  );
}
