import type { CountryCode } from 'libphonenumber-js/max';

export type Attendance = 'yes' | 'no';
export type GuestRole = 'primary' | 'additional';

export interface RsvpRecord {
  rsvpId: string;
  primaryGuestId: string;
  groupStatus: Attendance;
  totalPartySize: number;
  additionalGuestCount: number;
  partyRevision: number;
  createdAt: string;
  updatedAt: string;
}

export interface GuestRecord {
  guestId: string;
  rsvpId: string;
  role: GuestRole;
  name: string;
  country: CountryCode;
  phoneNormalized: string | null;
  phoneDisplay: string;
  attendance: Attendance;
  active: boolean;
  guestRevision: number;
  authVersion: number;
  createdAt: string;
  updatedAt: string;
}

export interface ExistingActor {
  role: GuestRole;
  rsvpId: string;
  guestId: string;
  authVersion: number;
}

export interface NewActor {
  role: 'new';
  phone: string;
  country: CountryCode;
}

export type Actor = ExistingActor | NewActor;

export interface OperationRecord {
  operationId: string;
  actorKey: string;
  payloadHash: string;
  resultActor: ExistingActor;
  createdAt: string;
}

export interface DomainSnapshot {
  rsvps: RsvpRecord[];
  guests: GuestRecord[];
  operations: OperationRecord[];
}

export interface LookupCommand {
  kind: 'lookup';
  phone: string;
  country: CountryCode;
}

export interface StateCommand {
  kind: 'state';
  actor: Actor;
}

export interface NewGuestInput {
  name: string;
  phone: string;
  country: CountryCode;
}

export interface NewPatch {
  kind: 'new';
  name: string;
  attendance: Attendance;
  guests: NewGuestInput[];
}

export interface SelfPatch {
  guestRevision: number;
  name?: string;
  phone?: string;
  country?: CountryCode;
}

export interface ExistingGuestUpsert extends SelfPatch {
  guestId: string;
}

export interface NewGuestUpsert extends NewGuestInput {
  guestId?: never;
  guestRevision?: never;
}

export interface GuestRemoval {
  guestId: string;
  guestRevision: number;
}

export interface PrimaryPatch {
  kind: 'primary';
  partyRevision?: number;
  self?: SelfPatch;
  attendance?: Attendance;
  upserts?: Array<ExistingGuestUpsert | NewGuestUpsert>;
  removals?: GuestRemoval[];
}

export interface AdditionalPatch extends SelfPatch {
  kind: 'additional';
}

export type SavePatch = NewPatch | PrimaryPatch | AdditionalPatch;

export interface SaveCommand {
  kind: 'save';
  actor: Actor;
  operationId: string;
  patch: SavePatch;
}

export type DomainCommand = LookupCommand | StateCommand | SaveCommand;

export interface NewState {
  kind: 'new';
  phone: string;
  country: CountryCode;
}

export interface AdditionalState {
  kind: 'additional';
  guestId: string;
  rsvpId: string;
  guestRevision: number;
  name: string;
  phone: string;
  country: CountryCode;
}

export interface PrimaryGuestState {
  guestId: string;
  guestRevision: number;
  name: string;
  phone: string;
  country: CountryCode;
}

export interface PrimaryState extends PrimaryGuestState {
  kind: 'primary';
  rsvpId: string;
  partyRevision: number;
  attendance: Attendance;
  totalPartySize: number;
  additionalGuestCount: number;
  guests: PrimaryGuestState[];
}

export type DomainState = NewState | AdditionalState | PrimaryState;

export interface DomainResult {
  snapshot: DomainSnapshot;
  actor: Actor;
  state: DomainState;
}

export type NewId = (kind: 'rsvp' | 'guest') => string;
export type HashValue = (value: string) => string;

export class DomainError extends Error {
  constructor(
    public readonly code:
      | 'invalid_request'
      | 'invalid_phone'
      | 'unauthorized'
      | 'not_found'
      | 'conflict'
      | 'phone_in_party'
      | 'phone_unavailable'
      | 'capacity',
    public readonly status: 400 | 403 | 404 | 409 | 422,
    public readonly safeMessage: string,
  ) {
    super(safeMessage);
    this.name = 'DomainError';
  }
}
