import {
  ArchiveRestore,
  Bot,
  Boxes,
  BrainCircuit,
  BriefcaseBusiness,
  Gauge,
  KeyRound,
  LibraryBig,
  MessageSquareText,
  ScrollText,
  Handshake,
  Settings,
  UsersRound,
  ContactRound,
  Wifi,
  RadioTower,
} from "lucide-react";

export const navigation = [
  { href: "/dashboard", label: "Dashboard", icon: Gauge },
  { href: "/whatsapp", label: "WhatsApp", icon: Wifi },
  { href: "/messages", label: "Messages", icon: MessageSquareText },
  { href: "/status", label: "Status WA", icon: RadioTower },
  { href: "/crm", label: "CRM", icon: Handshake },
  { href: "/contact-memory", label: "Contact Memory", icon: ContactRound },
  { href: "/groups", label: "Groups", icon: UsersRound },
  { href: "/agent-profile", label: "Agent Profile", icon: Bot },
  { href: "/knowledge", label: "Knowledge", icon: LibraryBig },
  { href: "/tools", label: "Tools", icon: Boxes },
  { href: "/jobs", label: "Jobs", icon: BriefcaseBusiness },
  { href: "/ai-provider", label: "AI Provider", icon: BrainCircuit },
  { href: "/logs", label: "Logs", icon: ScrollText },
  { href: "/backup", label: "Backup", icon: ArchiveRestore },
  { href: "/settings", label: "Settings", icon: Settings },
] as const;

export const authNavigation = { login: KeyRound };
