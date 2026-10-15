"use client";

import { useState, type FormEvent } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Button } from "../../components/ui/Button";
import { Field, Input } from "../../components/ui/Field";
import { Wordmark } from "../../components/ui/Wordmark";
import { register } from "../../lib/api";
import { apiErrorMessage } from "../../lib/errorMessages";
import styles from "./page.module.css";
import { Form, FormError, FormHint } from "../../components/ui/Form";

export default function RegisterPage() {
  const router = useRouter();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [setupCode, setSetupCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setPending(true);
    try {
      await register(email, password, name, setupCode);
      router.push("/");
      router.refresh();
    } catch (err) {
      setError(apiErrorMessage(err, "Registreringen misslyckades"));
      setPending(false);
    }
  }

  return (
    <div className={styles.wrapper}>
      <div className={styles.card}>
        <div className={styles.wordmarkRow}>
          <Wordmark height={44} />
        </div>
        <div className={styles.subtitle}>Skapa det första kontot (blir administratör)</div>

        <Form onSubmit={handleSubmit}>
          <FormError>{error}</FormError>

          <Field label="Engångskod" htmlFor="setupCode">
            <Input
              id="setupCode"
              autoComplete="one-time-code"
              autoCapitalize="characters"
              spellCheck={false}
              required
              value={setupCode}
              onChange={(e) => setSetupCode(e.target.value)}
            />
          </Field>
          <FormHint attached>
            Skrivs i API:ts logg när det startar: kör <code>docker compose logs api</code> på servern.
          </FormHint>

          <Field label="Namn" htmlFor="name">
            <Input id="name" autoComplete="name" required value={name} onChange={(e) => setName(e.target.value)} />
          </Field>

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
              autoComplete="new-password"
              minLength={8}
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </Field>
          <FormHint attached>Minst 8 tecken.</FormHint>

          <Button type="submit" variant="primary" className={styles.submit} disabled={pending}>
            {pending ? "Skapar konto…" : "Skapa konto"}
          </Button>
        </Form>

        <div className={styles.footer}>
          Har du redan ett konto? <Link href="/login">Logga in</Link>
        </div>
      </div>
    </div>
  );
}
