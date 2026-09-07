import { GUEST_LOCKUP } from "@/lib/aether/constants";
import { HotelMark } from "./hotel-mark";
import { ThemeToggle } from "./theme-toggle";

export function GuestHeader({ hotelName }: { hotelName: string }) {
  return (
    <header className="flex items-center justify-between gap-4 border-b border-line px-5 py-4">
      <div className="flex min-w-0 items-center gap-3">
        <HotelMark name={hotelName} size="sm" />
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold">{hotelName}</p>
          <p className="text-xs tracking-widest text-muted uppercase">{GUEST_LOCKUP}</p>
        </div>
      </div>
      <ThemeToggle />
    </header>
  );
}
