"use client";

import { useRouter } from "next/navigation";
import { Button } from "./ui/Button";
import { logout } from "../lib/api";

export function LogoutButton() {
  const router = useRouter();

  async function handleLogout() {
    await logout();
    router.push("/login");
    router.refresh();
  }

  return (
    <Button variant="ghost" size="small" onClick={handleLogout}>
      Logga ut
    </Button>
  );
}
