// STEP 0 measurement — counts AUTHENTIC owner-sent 1:1 messages in chat.db.
//
// Run from a shell that HAS Full Disk Access (your Terminal — the bridge's
// launchd context already does; an unprivileged sandbox cannot open chat.db):
//
//   cd services/imessage-bridge
//   npx tsx scripts/measure-owner-voice.mts
//
// Read-only. Prints aggregate counts only — never message text (PII).
import Database from "better-sqlite3";
import { homedir } from "os";
import { join } from "path";
import { decodeAttributedBody } from "../src/attributed-body.js";
import { dedupeKey } from "@lantern/bridge-core/owner-voice";

const TELUGU_TOKENS = new Set([
  "vasta","vastha","vacchaka","vacchina","vacchi","cheptha","cheptanu","chepta","matladta","matladtham","matladkundam","ela","undi","unna","unnav","unnaru","chustha","chusta","chustanu","ostha","osta","ostunnav","ostunnaru","thelvadu","telidu","teliyadu","leda","ledu","ledhu","kavali","emi","enti","emaindi","amma","nanna","anna","akka","bava","vadina","ammayi","abbayi","cheppu","cheppara","sare","tappakunda","mari","koncham","baagunnav","bagunnava","ekkada","epudu","chesthunnav","chestunna","nuvvu","meeru","nenu","repu","kada",
]);
const TELUGU_SCRIPT_RE = /[ఀ-౿]/;
function isTelugu(msg: string): boolean {
  if (TELUGU_SCRIPT_RE.test(msg)) return true;
  for (const t of msg.toLowerCase().split(/[^a-zఀ-౿]+/).filter(Boolean)) {
    if (TELUGU_TOKENS.has(t)) return true;
  }
  return false;
}

const path = join(homedir(), "Library/Messages/chat.db");
const db = new Database(path, { readonly: true, fileMustExist: true });

const totalFromMe = (db.prepare(`SELECT COUNT(*) c FROM message WHERE is_from_me=1`).get() as { c: number }).c;

const rows = db.prepare(
  `SELECT COALESCE(m.text,'') AS text, m.attributedBody AS ab
   FROM message m
   LEFT JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
   LEFT JOIN chat c ON c.ROWID = cmj.chat_id
   WHERE m.is_from_me = 1
     AND COALESCE(m.associated_message_type,0) = 0
     AND COALESCE(c.display_name,'') = ''
     AND (COALESCE(m.text,'') <> '' OR m.attributedBody IS NOT NULL)
   ORDER BY m.ROWID DESC`
).all() as Array<{ text: string; ab: Buffer | null }>;

let nonEmpty = 0, inRange = 0, teluguN = 0, shortN = 0, longN = 0;
const seen = new Set<string>();
let uniq = 0, uniqTelugu = 0;
for (const r of rows) {
  const text = ((r.text || "").trim() || decodeAttributedBody(r.ab) || "").trim();
  if (!text) continue;
  nonEmpty++;
  if (text.length < 2 || text.length > 280) continue;
  inRange++;
  if (text.length <= 40) shortN++; else longN++;
  if (isTelugu(text)) teluguN++;
  const key = dedupeKey(text);
  if (key && seen.has(key)) continue;
  if (key) seen.add(key);
  uniq++;
  if (isTelugu(text)) uniqTelugu++;
}

console.log(JSON.stringify({
  totalFromMe_raw: totalFromMe,
  scanned_1to1_nonTapback_withBody: rows.length,
  nonEmptyAfterDecode: nonEmpty,
  inLengthRange_2to280: inRange,
  short_le40chars: shortN,
  long_gt40chars: longN,
  telugu_inRange: teluguN,
  unique_after_dedupe: uniq,
  unique_telugu: uniqTelugu,
}, null, 2));
db.close();
