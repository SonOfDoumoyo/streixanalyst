"use client";
import { Suspense } from "react";
import { AuthShell, LoginForm } from "@/components/AuthForms";

export default function Page() {
  return (
    <AuthShell>
      <Suspense fallback={null}>
        <LoginForm />
      </Suspense>
    </AuthShell>
  );
}
