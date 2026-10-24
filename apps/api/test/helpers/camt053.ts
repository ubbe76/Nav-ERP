// Builds a small camt.053.001.02 (kontoutdrag) for the reconciliation
// suites, in schema order. camt053.test.ts validates the builder's output
// against the official XSD, so every suite's generated statements are
// known-valid.
export interface Camt053Tx {
  acctSvcrRef?: string;
  endToEndId?: string;
  msgId?: string;
  amount?: number;
  counterparty?: string;
  ustrd?: string;
  scor?: string;
  cinv?: string;
  addtlTxInf?: string;
}

export interface Camt053Entry {
  direction: "credit" | "debit";
  amount: number;
  bookingDate: string;
  valueDate?: string;
  acctSvcrRef?: string;
  ntryRef?: string;
  status?: string;
  reversal?: boolean;
  addtlNtryInf?: string;
  txs?: Camt053Tx[];
}

export interface Camt053Statement {
  id?: string;
  // IBAN or BBAN (Othr/Id with Cd BBAN); default a BBAN.
  iban?: string;
  bban?: string;
  currency?: string;
  from?: string;
  to?: string;
  opening?: { amount: number; date: string };
  closing?: { amount: number; date: string };
  entries: Camt053Entry[];
}

const money = (n: number, ccy = "SEK") => `<Amt Ccy="${ccy}">${Math.abs(n).toFixed(2)}</Amt>`;

function balance(code: string, b: { amount: number; date: string }, ccy: string): string {
  return `<Bal><Tp><CdOrPrtry><Cd>${code}</Cd></CdOrPrtry></Tp>${money(b.amount, ccy)}<CdtDbtInd>${b.amount < 0 ? "DBIT" : "CRDT"}</CdtDbtInd><Dt><Dt>${b.date}</Dt></Dt></Bal>`;
}

function tx(entry: Camt053Entry, t: Camt053Tx, ccy: string): string {
  const refs = [t.msgId ? `<MsgId>${t.msgId}</MsgId>` : "", t.acctSvcrRef ? `<AcctSvcrRef>${t.acctSvcrRef}</AcctSvcrRef>` : "", t.endToEndId ? `<EndToEndId>${t.endToEndId}</EndToEndId>` : ""].join("");
  const amount = t.amount !== undefined ? `<AmtDtls><TxAmt>${money(t.amount, ccy)}</TxAmt></AmtDtls>` : "";
  const party = t.counterparty
    ? `<RltdPties>${entry.direction === "credit" && !entry.reversal ? `<Dbtr><Nm>${t.counterparty}</Nm></Dbtr>` : `<Cdtr><Nm>${t.counterparty}</Nm></Cdtr>`}</RltdPties>`
    : "";
  const strd = [
    t.cinv ? `<RfrdDocInf><Tp><CdOrPrtry><Cd>CINV</Cd></CdOrPrtry></Tp><Nb>${t.cinv}</Nb></RfrdDocInf>` : "",
    t.scor ? `<CdtrRefInf><Tp><CdOrPrtry><Cd>SCOR</Cd></CdOrPrtry></Tp><Ref>${t.scor}</Ref></CdtrRefInf>` : "",
  ].join("");
  const remittance = t.ustrd || strd ? `<RmtInf>${t.ustrd ? `<Ustrd>${t.ustrd}</Ustrd>` : ""}${strd ? `<Strd>${strd}</Strd>` : ""}</RmtInf>` : "";
  return `<TxDtls>${refs ? `<Refs>${refs}</Refs>` : ""}${amount}${party}${remittance}${t.addtlTxInf ? `<AddtlTxInf>${t.addtlTxInf}</AddtlTxInf>` : ""}</TxDtls>`;
}

function ntry(e: Camt053Entry, ccy: string): string {
  return (
    `<Ntry>${e.ntryRef ? `<NtryRef>${e.ntryRef}</NtryRef>` : ""}${money(e.amount, ccy)}<CdtDbtInd>${e.direction === "credit" ? "CRDT" : "DBIT"}</CdtDbtInd>` +
    `${e.reversal ? "<RvslInd>true</RvslInd>" : ""}<Sts>${e.status ?? "BOOK"}</Sts><BookgDt><Dt>${e.bookingDate}</Dt></BookgDt>` +
    `${e.valueDate ? `<ValDt><Dt>${e.valueDate}</Dt></ValDt>` : ""}${e.acctSvcrRef ? `<AcctSvcrRef>${e.acctSvcrRef}</AcctSvcrRef>` : ""}` +
    `<BkTxCd><Domn><Cd>PMNT</Cd><Fmly><Cd>${e.direction === "credit" ? "RCDT" : "ICDT"}</Cd><SubFmlyCd>${e.direction === "credit" ? "ESCT" : "ESCT"}</SubFmlyCd></Fmly></Domn></BkTxCd>` +
    `${e.txs && e.txs.length > 0 ? `<NtryDtls>${e.txs.map((t) => tx(e, t, ccy)).join("")}</NtryDtls>` : ""}` +
    `${e.addtlNtryInf ? `<AddtlNtryInf>${e.addtlNtryInf}</AddtlNtryInf>` : ""}</Ntry>`
  );
}

export function camt053File(input: { messageId: string; created?: string; statements: Camt053Statement[] }): string {
  const created = input.created ?? "2024-10-10T02:15:00+02:00";
  const stmts = input.statements
    .map((s, i) => {
      const ccy = s.currency ?? "SEK";
      const acct = s.iban ? `<Id><IBAN>${s.iban}</IBAN></Id>` : `<Id><Othr><Id>${s.bban ?? "821491234567890"}</Id><SchmeNm><Cd>BBAN</Cd></SchmeNm></Othr></Id>`;
      const period = s.from && s.to ? `<FrToDt><FrDtTm>${s.from}T00:00:00+02:00</FrDtTm><ToDtTm>${s.to}T23:59:59+02:00</ToDtTm></FrToDt>` : "";
      const bals = `${s.opening ? balance("OPBD", s.opening, ccy) : ""}${s.closing ? balance("CLBD", s.closing, ccy) : ""}`;
      return `<Stmt><Id>${s.id ?? `${input.messageId}-${i + 1}`}</Id><CreDtTm>${created}</CreDtTm>${period}<Acct>${acct}<Ccy>${ccy}</Ccy></Acct>${bals}${s.entries.map((e) => ntry(e, ccy)).join("")}</Stmt>`;
    })
    .join("");
  return `<?xml version="1.0" encoding="UTF-8"?><Document xmlns="urn:iso:std:iso:20022:tech:xsd:camt.053.001.02"><BkToCstmrStmt><GrpHdr><MsgId>${input.messageId}</MsgId><CreDtTm>${created}</CreDtTm></GrpHdr>${stmts}</BkToCstmrStmt></Document>`;
}
