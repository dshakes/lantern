// The PAL Promise. Each line maps to a shipped mechanism and links to its docs.
export const PROMISE = [
  {
    kind: 'voice', title: 'Sounds like you.', href: 'docs/pal/',
    body: 'pal writes the way you write. Every reply is scored against messages you really sent, and a draft that drifts from your voice is rewritten before it goes out.',
  },
  {
    kind: 'people', title: 'Remembers your people.', href: 'docs/pal/knowledge/',
    body: 'One memory of each person across iMessage and WhatsApp: what you talked about, what you planned, what you promised.',
  },
  {
    kind: 'asks', title: 'Asks before it promises.', href: 'docs/pal/human-in-the-loop/',
    body: 'Money, commitments and anything it cannot verify are held for your yes. Nothing that matters goes out on a guess.',
  },
  {
    kind: 'steady', title: 'Never stops, never leaks.', href: 'docs/runtime/durable-execution/',
    body: 'Runs pick up where they left off after a crash. Untrusted code runs in a microVM, keys stay outside it, and every run can carry a signed receipt.',
  },
] as const;
