/**
 * Icons for the card's fixed action types and social platforms. Decorative only: every button
 * and link also carries its text (visible, or as its accessible name).
 */
import {
  AtSign,
  BookOpen,
  Camera,
  FileDown,
  Globe,
  Link2,
  Mail,
  MessageCircle,
  Music2,
  Navigation,
  Phone,
  PlayCircle,
  Send,
  Share2,
  ShoppingBag,
  ThumbsUp,
  Briefcase,
  UserPlus,
  type LucideIcon,
} from 'lucide-react';

import type { ActionType, SocialPlatform } from '@/lib/businessCards';

export const ACTION_ICONS: Record<ActionType, LucideIcon> = {
  call: Phone,
  whatsapp: MessageCircle,
  email: Mail,
  navigate: Navigation,
  save_contact: UserPlus,
  share: Share2,
  digital_menu: BookOpen,
  order_online: ShoppingBag,
  website: Globe,
  link: Link2,
  file: FileDown,
  enquiry: Send,
};

export const PLATFORM_ICONS: Record<SocialPlatform, LucideIcon> = {
  instagram: Camera,
  facebook: ThumbsUp,
  tiktok: Music2,
  linkedin: Briefcase,
  youtube: PlayCircle,
  x: AtSign,
  telegram: Send,
  other: Link2,
};
