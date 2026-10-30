import {
  Activity, BarChart3, Bot, DollarSign, FileText, FlaskConical, Gauge, Inbox, MessageSquare, Mic, Play, Plug,
  Radio, Rocket, Server, Shield, Smartphone, Split, Store, Sun, Users, Zap, type LucideIcon,
} from "lucide-react";
import type { NavIcon as NavIconName } from "@/lib/workspace-nav";

const ICONS: Record<NavIconName, LucideIcon> = {
  sun: Sun, "inbox-check": Inbox, zap: Zap, message: MessageSquare, users: Users, mic: Mic, file: FileText,
  shield: Shield, smartphone: Smartphone, gauge: Gauge, bot: Bot, play: Play, server: Server, rocket: Rocket,
  flask: FlaskConical, chart: BarChart3, dollar: DollarSign, split: Split, plug: Plug, radio: Radio, store: Store,
  activity: Activity,
};

export function navIcon(name: NavIconName): LucideIcon {
  return ICONS[name];
}
