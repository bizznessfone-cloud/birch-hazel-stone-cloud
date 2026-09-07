import { hotelMarkLetters } from "@/lib/aether/hotel";

export function HotelMark({
  name,
  size = "md",
}: {
  name: string;
  size?: "sm" | "md" | "lg";
}) {
  const letters = hotelMarkLetters(name);
  const box =
    size === "lg" ? "h-20 w-20 text-2xl" : size === "sm" ? "h-10 w-10 text-sm" : "h-14 w-14 text-lg";
  return (
    <div
      aria-hidden
      className={`flex shrink-0 items-center justify-center overflow-visible border border-ink font-semibold leading-none tracking-wide ${box}`}
    >
      {letters}
    </div>
  );
}
