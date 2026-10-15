"use client";
import { Suspense } from "react";
import { AuthShell, SignupForm } from "@/components/AuthForms";

export default function Page() {
  return (
    <AuthShell>
      <Suspense fallback={null}>
        <SignupForm />
      </Suspense>
    </AuthShell>
  );
}
