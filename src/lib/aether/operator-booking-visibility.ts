/** Gate 2 operator booking visibility contract — intentionally not activated.
 * Property permission alone must never disclose guest contact, booking token,
 * payment data, or a hotel owner's dispatch and fleet controls.
 */
export const OPERATOR_BOOKING_SAFE_FIELDS = [
  "bookingId",
  "humanReference",
  "transferDate",
  "pickupTime",
  "passengerCount",
  "luggageCount",
  "pickupText",
  "destinationText",
  "cancelled",
] as const;

export type OperatorBookingSafeField = typeof OPERATOR_BOOKING_SAFE_FIELDS[number];
export type OperatorBookingSummary = {
  bookingId: string;
  humanReference: string;
  transferDate: string;
  pickupTime: string;
  passengerCount: number;
  luggageCount: number;
  pickupText: string;
  destinationText: string;
  cancelled: boolean;
};

export function toOperatorBookingSummary(row: Record<string, unknown>): OperatorBookingSummary {
  const requiredString = (name: string) => {
    if (typeof row[name] !== "string" || !(row[name] as string).trim()) throw new Error("Invalid operator booking record");
    return row[name] as string;
  };
  const requiredCount = (name: string) => {
    const value = row[name];
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new Error("Invalid operator booking record");
    return value;
  };
  if (typeof row.cancelled !== "boolean") throw new Error("Invalid operator booking record");
  return {
    bookingId: requiredString("bookingId"),
    humanReference: requiredString("humanReference"),
    transferDate: requiredString("transferDate"),
    pickupTime: requiredString("pickupTime"),
    passengerCount: requiredCount("passengerCount"),
    luggageCount: requiredCount("luggageCount"),
    pickupText: requiredString("pickupText"),
    destinationText: requiredString("destinationText"),
    cancelled: row.cancelled,
  };
}
