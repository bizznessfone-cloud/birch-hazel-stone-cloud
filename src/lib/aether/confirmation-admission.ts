/**
 * Stage E paid-confirmation claim.
 * Not called by guest booking creation. Does not send email itself.
 * A claim is not delivery. The sender runs only after the claim statement
 * has finished, and only for aether_mailer.
 */

export type MailerDb = {
  query<T = Record<string, unknown>>(text: string, params?: unknown[]): Promise<T[]>;
};

export type EmailClaim = {
  outcome: string;
  bookingId: string | null;
  claimToken: string | null;
  attemptCount: number | null;
};

export type EmailResult = {
  outcome: string;
  state: string | null;
};

export type PaidConfirmationPayload = {
  bookingId: string;
  recipient: string;
  guestName: string;
  reference: string;
  transferDate: string;
  pickupTime: string;
  durationMinutes: number;
  pickup: string;
  destination: string;
  passengers: number;
  luggage: number;
  hotelName: string;
  confirmationToken: string;
};

const CLAIM_SQL = `select * from sbg_claim_confirmation_email($1::uuid)`;
const RECORD_SQL = `select * from sbg_record_confirmation_email_result($1::uuid, $2::uuid, $3, $4)`;
const READ_SQL = `select * from sbg_read_confirmation_email_payload($1::uuid)`;

export async function claimPaidConfirmation(db: MailerDb, bookingId: string): Promise<EmailClaim> {
  const rows = await db.query<{
    email_outcome: string;
    email_booking_id: string | null;
    email_claim_token: string | null;
    email_attempt_count: number | null;
  }>(CLAIM_SQL, [bookingId]);
  const row = rows[0];
  if (!row) throw new Error("email_claim_missing");
  return {
    outcome: row.email_outcome,
    bookingId: row.email_booking_id,
    claimToken: row.email_claim_token,
    attemptCount: row.email_attempt_count,
  };
}

export async function recordPaidConfirmationResult(
  db: MailerDb,
  bookingId: string,
  claimToken: string,
  result: "sent" | "failed",
  providerCode: string | null,
): Promise<EmailResult> {
  const rows = await db.query<{ email_outcome: string; email_state: string | null }>(RECORD_SQL, [
    bookingId,
    claimToken,
    result,
    providerCode,
  ]);
  const row = rows[0];
  if (!row) throw new Error("email_result_missing");
  return { outcome: row.email_outcome, state: row.email_state };
}

export async function readPaidConfirmationPayload(
  db: MailerDb,
  claimToken: string,
): Promise<PaidConfirmationPayload | null> {
  const rows = await db.query<{
    payload_booking_id: string;
    payload_recipient: string;
    payload_guest_name: string;
    payload_reference: string;
    payload_transfer_date: string;
    payload_pickup_time: string;
    payload_duration_minutes: number;
    payload_pickup: string;
    payload_destination: string;
    payload_passengers: number;
    payload_luggage: number;
    payload_hotel_name: string;
    payload_confirmation_token: string;
  }>(READ_SQL, [claimToken]);
  const row = rows[0];
  if (!row) return null;
  return {
    bookingId: row.payload_booking_id,
    recipient: row.payload_recipient,
    guestName: row.payload_guest_name,
    reference: row.payload_reference,
    transferDate: String(row.payload_transfer_date),
    pickupTime: String(row.payload_pickup_time),
    durationMinutes: row.payload_duration_minutes,
    pickup: row.payload_pickup,
    destination: row.payload_destination,
    passengers: row.payload_passengers,
    luggage: row.payload_luggage,
    hotelName: row.payload_hotel_name,
    confirmationToken: row.payload_confirmation_token,
  };
}

export async function deliverPaidConfirmation(
  db: MailerDb,
  bookingId: string,
  sender: (payload: PaidConfirmationPayload) => Promise<"sent" | "failed">,
): Promise<EmailClaim & { result: string | null }> {
  const claim = await claimPaidConfirmation(db, bookingId);
  if (!claim.claimToken || !["claimed", "reclaimed", "retry"].includes(claim.outcome)) {
    return { ...claim, result: null };
  }
  let delivery: "sent" | "failed" = "failed";
  let providerCode: string | null = "provider_unavailable";
  try {
    const payload = await readPaidConfirmationPayload(db, claim.claimToken);
    if (payload) {
      delivery = await sender(payload);
      providerCode = delivery === "sent" ? null : "provider_rejected";
    }
  } catch {
    delivery = "failed";
    providerCode = "provider_unavailable";
  }
  const recorded = await recordPaidConfirmationResult(
    db,
    bookingId,
    claim.claimToken,
    delivery,
    providerCode,
  );
  return { ...claim, result: recorded.outcome };
}
