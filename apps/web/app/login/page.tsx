"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { Button } from "../../components/ui/Button";
import { Field, Input } from "../../components/ui/Field";
import { Wordmark } from "../../components/ui/Wordmark";
import { login } from "../../lib/api";
import { apiErrorMessage } from "../../lib/errorMessages";
import styles from "./page.module.css";
import { Form, FormError } from "../../components/ui/Form";

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setPending(true);
    try {
      await login(email, password);
      router.push("/");
      router.refresh();
    } catch (err) {
      setError(apiErrorMessage(err, "Inloggningen misslyckades"));
      setPending(false);
    }
  }

  return (
    <div className={styles.wrapper}>
      <div className={styles.card}>
        <div className={styles.wordmarkRow}>
          <Wordmark height={44} />
        </div>
        <div className={styles.subtitle}>Logga in för att fortsätta</div>

        <Form onSubmit={handleSubmit}>
          <FormError>{error}</FormError>

          <Field label="E-post" htmlFor="email">
            <Input
              id="email"
              type="email"
              autoComplete="username"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </Field>

          <Field label="Lösenord" htmlFor="password">
            <Input
              id="password"
              type="password"
              autoComplete="current-password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </Field>

          <Button type="submit" variant="primary" className={styles.submit} disabled={pending}>
            {pending ? "Loggar in…" : "Logga in"}
          </Button>
        </Form>
      </div>
    </div>
  );
}
