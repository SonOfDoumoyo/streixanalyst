"use client";
import { Suspense } from "react";
import Terminal from "@/components/terminal/Terminal";
import { FullScreenLoader, RequireAuth } from "@/components/ui";
import Tour from "@/components/Tour";

export default function TerminalPage() {
  return (
    <RequireAuth>
      <Suspense fallback={<FullScreenLoader text="Opening the terminal" />}>
        <Terminal />
      </Suspense>
      <Tour />
    </RequireAuth>
  );
}
