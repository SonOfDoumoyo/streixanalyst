"use client";
import { Suspense } from "react";
import { AuthShell, OnboardingForm } from "@/components/AuthForms";
import { RequireAuth } from "@/components/ui";

export default function Page() {
  return (
    <RequireAuth>
      <AuthShell>
        <Suspense fallback={null}>
          <OnboardingForm />
        </Suspense>
      </AuthShell>
    </RequireAuth>
  );
}
