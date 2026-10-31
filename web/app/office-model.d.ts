// Types for the build-free office-model.js so check:office can import it without loosening the compiler.
import type { VillageRow } from "./village.js";

export interface OfficeRow extends VillageRow {
  failure?: unknown;
  stuck?: unknown;
  tool?: { name?: string } | null;
  hue?: number;
  emoji?: string;
}
export type Pose = "absent" | "arriving" | "typing" | "waiting" | "slumped" | "roam";
export interface Seat { pod: string; i: number }
export type SeatStore = Record<string, Seat>;
export interface Point { x: number; z: number }
export interface Spot extends Point { exit?: Point }
export interface Desk extends Point { name: string | null; i: number; yaw: number; chair: Point; exit: Point }
export interface Pod { key: string; label: string; x: number; z: number; w: number; d: number; rugColor: string; desks: Desk[] }
export interface Waypoint extends Point { kind: string; yaw: number; act: string; exit: Point }
export interface OfficeLayout {
  room: { w: number; d: number };
  pods: Pod[];
  you: Point & { yaw: number; exit: Point };
  amenities: Array<Point & { kind: string; yaw: number }>;
  waypoints: Waypoint[];
  lanes: { x: number[]; z: number[] };
  door: Point & { exit: Point };
  windows: { back: number[]; left: number[] };
}
export interface VillageEdge { a: string; b: string; count: number; lastTs: number }
export interface VillageSnapshot { edges?: VillageEdge[]; last?: Record<string, { text: string; ts: number }> }
export interface DmEvent { a: string; b: string; delta: number; count: number; lastTs: number }
export interface LabelRect { id: string; x: number; y: number; w: number; h: number; priority: number; depth?: number }
export interface Limbs {
  legL: number; legR: number; shinL: number; shinR: number; armL: number; armR: number; armLz: number; armRz: number;
  head: number; headTilt: number; lean: number; bob: number; breathe: number; seated: boolean;
}

export const DESK_W: number;
export const DESK_D: number;
export const CHAIR_CLEAR: number;
export const AISLE: number;
export const RUG_MARGIN: number;
export const PAIRS_PER_BLOCK: number;
export const BACK_STRIP: number;
export const FRONT_STRIP: number;
export const WORKERS: string;
export const RUG_COLORS: string[];
export const HAIR_FALLBACK: string[];
export const HAIR_STYLES: string[];
export const SEATED_POSES: Set<string>;
export function hashStr(s: string): number;
export function nameHue(name: string): number;
export function poseFor(row: OfficeRow | undefined): Pose;
export function statusDot(pose: Pose): "live" | "waiting" | "failed" | "idle";
export function pillDetail(row: OfficeRow, pose: Pose): string;
export function lookFor(name: string, row?: OfficeRow): { hue: number; hair: string; style: string; emoji: string };
export function podKeysFor(rows: OfficeRow[]): Map<string, string>;
export function podLabel(key: string): string;
export function seatsFrom(store: SeatStore, podOf: Map<string, string>): SeatStore;
export function assignSeats(space: string, rows: OfficeRow[]): SeatStore;
export function deskSlot(i: number): { x: number; z: number; yaw: number; chairZ: number; side: number; block: number };
export function officeLayout(rows: OfficeRow[], seats: SeatStore, podRank?: (key: string) => number | string): OfficeLayout;
export function route(layout: OfficeLayout, a: Spot, b: Spot): Point[];
export function diffEdges(prev: VillageSnapshot | undefined | null, next: VillageSnapshot | undefined | null): DmEvent[];
export function senderOf(ev: { a: string; b: string }, last?: Record<string, { ts: number }>): { from: string; to: string };
export function clip(text: string, n: number): string;
export function labelPriority(o: { selected?: boolean; pose?: string }): number;
export function cullLabels(rects: LabelRect[]): Set<string>;
export function limbAngles(pose: string, t: number, phase?: number): Limbs;
export function podOrder(space: string, keys: string[]): (key: string) => number;
export function relTime(ts: number, now?: number): string;
