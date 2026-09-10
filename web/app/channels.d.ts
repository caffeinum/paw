export const GENERAL: "general";
export interface ChannelMemberView { name: string; agent: boolean; live: boolean }
export interface RosterRow { name: string; mesh?: string; [k: string]: unknown }
export function channelMembersFor(channel: string, members: Record<string, string[]> | undefined, rows: RosterRow[]): ChannelMemberView[];
export function sortMembers(list: ChannelMemberView[]): ChannelMemberView[];
export function loadOpen(space: string): Record<string, true>;
export function saveOpen(space: string, open: Record<string, true>): void;
export function toggleOpen(open: Record<string, true>, channel: string): Record<string, true>;
export interface ChannelActivity { latest: number; unread: number }
export function loadSeen(space: string): Record<string, number>;
export function saveSeen(space: string, seen: Record<string, number>): void;
export function markSeen(seen: Record<string, number>, channel: string, ts: number): Record<string, number>;
export function channelUnread(activity: Record<string, ChannelActivity> | undefined, channel: string): number;
