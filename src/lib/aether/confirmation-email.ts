/**
 * Centralized transactional booking confirmation email.
 * Server-only: never expose RESEND_API_KEY or send mail from the browser.
 * Email delivery is deliberately failure-isolated from booking creation.
 */

import type { CreatedBooking } from "./booking";

export type ConfirmationEmailStatus = "sent" | "not_configured" | "failed";

type SendResult = {
  status: ConfirmationEmailStatus;
};

function env(name: string): string | undefined {
  const value = process.env[name];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function confirmationUrl(booking: CreatedBooking, origin?: string): string {
  const base = origin?.trim() || env("PUBLIC_APP_URL") || "https://scan-book-go.vercel.app";
  return `${base.replace(/\/$/, "")}/confirmed/${encodeURIComponent(booking.confirmationToken)}`;
}

function subject(booking: CreatedBooking): string {
  return `Transfer confirmed · ${booking.humanReference}`;
}

function textBody(booking: CreatedBooking, url: string): string {
  const price = booking.pricing.priced
    ? `${booking.pricing.currency} ${(booking.pricing.amountMinor / 100).toFixed(2)}`
    : "To be confirmed";

  return [
    `Your transfer is confirmed for ${booking.hotelName}.`,
    "",
    `Booking reference: ${booking.humanReference}`,
    `Date: ${booking.transferDate}`,
    `Pickup time: ${booking.pickupTime}`,
    `Pickup: ${booking.pickupText}`,
    `Destination: ${booking.destinationText}`,
    `Passengers: ${booking.passengerCount}`,
    `Luggage: ${booking.luggageCount}`,
    `Price: ${price}`,
    "",
    `View your booking securely: ${url}`,
    "",
    "Keep this email for your records.",
  ].join("\n");
}

function htmlBody(booking: CreatedBooking, url: string): string {
  const price = booking.pricing.priced
    ? `${escapeHtml(booking.pricing.currency)} ${(booking.pricing.amountMinor / 100).toFixed(2)}`
    : "To be confirmed";

  const row = (label: string, value: string) =>
    `<tr><td style="padding:8px 12px;color:#666;font-size:12px;text-transform:uppercase;letter-spacing:.08em">${escapeHtml(label)}</td><td style="padding:8px 12px;text-align:right;font-weight:600">${escapeHtml(value)}</td></tr>`;

  return `<!doctype html>
<html><body style="margin:0;background:#f5f5f2;color:#171717;font-family:Arial,Helvetica,sans-serif">
  <div style="max-width:560px;margin:0 auto;padding:32px 20px">
    <div style="background:#fff;border:1px solid #ddd;padding:28px">
      <p style="margin:0;color:#666;font-size:12px;letter-spacing:.12em;text-transform:uppercase">SCAN / BOOK / GO</p>
      <h1 style="margin:16px 0 8px;font-size:28px;line-height:1.15">Transfer confirmed</h1>
      <p style="margin:0 0 24px;color:#666;line-height:1.5">Your transfer with ${escapeHtml(booking.hotelName)} has been booked successfully.</p>
      <p style="margin:0 0 20px;font-size:30px;font-weight:700;letter-spacing:.04em">${escapeHtml(booking.humanReference)}</p>
      <table style="width:100%;border-collapse:collapse;border:1px solid #ddd">${row("Hotel", booking.hotelName)}${row("When", `${booking.transferDate} · ${booking.pickupTime}`)}${row("Pickup", booking.pickupText)}${row("Destination", booking.destinationText)}${row("Party", `${booking.passengerCount} passengers · ${booking.luggageCount} bags`)}${row("Price", price)}</table>
      <a href="${escapeHtml(url)}" style="display:block;margin-top:28px;padding:15px 18px;background:#171717;color:#fff;text-align:center;text-decoration:none;font-weight:700">View My Booking</a>
      <p style="margin:20px 0 0;color:#777;font-size:12px;line-height:1.5">This secure link is the credential for viewing your booking. Keep it private.</p>
    </div>
  </div>
</body></html>`;
}

export async function sendConfirmationEmail(
  booking: CreatedBooking,
  recipientEmail: string,
  options: { origin?: string } = {},
): Promise<SendResult> {
  const apiKey = env("RESEND_API_KEY");
  const from = env("RESEND_FROM_EMAIL");

  if (!apiKey || !from) {
    return { status: "not_configured" };
  }

  const url = confirmationUrl(booking, options.origin);

  try {
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "Idempotency-Key": `booking-confirmation-${booking.humanReference}`,
      },
      body: JSON.stringify({
        from,
        to: [recipientEmail],
        subject: subject(booking),
        text: textBody(booking, url),
        html: htmlBody(booking, url),
      }),
    });

    if (!response.ok) {
      return { status: "failed" };
    }

    return { status: "sent" };
  } catch {
    return { status: "failed" };
  }
}
