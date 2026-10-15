// Builds a small camt.054.001.02 for the service/route suites (Task 7–8),
// in schema order. camt054.test.ts validates one against the XSD, so every
// suite's generated files are known-valid.
export interface CamtTx {
  acctSvcrRef?: string;
  clrSysRef?: string;
  endToEndId?: string;
  msgId?: string;
  amount: number;
  counterparty?: string;
  refs?: { type: "SCOR" | "CINV" | "CREN"; value: string; amount?: number }[];
  ustrd?: string;
  returnReason?: string;
}
export interface CamtEntry {
  direction: "credit" | "debit";
  reversal?: boolean;
  amount: number;
  bookingDate: string;
  acctSvcrRef?: string;
  status?: string;
  txs: CamtTx[];
}

const money = (n: number) => `<Amt Ccy="SEK">${n.toFixed(2)}</Amt>`;

function strd(ref: NonNullable<CamtTx["refs"]>[number]): string {
  if (ref.type === "SCOR") {
    const amount = ref.amount !== undefined ? `<RfrdDocAmt><RmtdAmt Ccy="SEK">${ref.amount.toFixed(2)}</RmtdAmt></RfrdDocAmt>` : "";
    return `<Strd>${amount}<CdtrRefInf><Tp><CdOrPrtry><Cd>SCOR</Cd></CdOrPrtry></Tp><Ref>${ref.value}</Ref></CdtrRefInf></Strd>`;
  }
  const amount =
    ref.amount === undefined
      ? ""
      : ref.type === "CREN"
        ? `<RfrdDocAmt><CdtNoteAmt Ccy="SEK">${ref.amount.toFixed(2)}</CdtNoteAmt></RfrdDocAmt>`
        : `<RfrdDocAmt><RmtdAmt Ccy="SEK">${ref.amount.toFixed(2)}</RmtdAmt></RfrdDocAmt>`;
  return `<Strd><RfrdDocInf><Tp><CdOrPrtry><Cd>${ref.type}</Cd></CdOrPrtry></Tp><Nb>${ref.value}</Nb></RfrdDocInf>${amount}</Strd>`;
}

function tx(entry: CamtEntry, t: CamtTx): string {
  const refs = [
    t.msgId ? `<MsgId>${t.msgId}</MsgId>` : "",
    t.acctSvcrRef ? `<AcctSvcrRef>${t.acctSvcrRef}</AcctSvcrRef>` : "",
    t.endToEndId ? `<EndToEndId>${t.endToEndId}</EndToEndId>` : "",
    t.clrSysRef ? `<ClrSysRef>${t.clrSysRef}</ClrSysRef>` : "",
  ].join("");
  const party = t.counterparty
    ? `<RltdPties>${entry.direction === "credit" ? `<Dbtr><Nm>${t.counterparty}</Nm></Dbtr>` : `<Cdtr><Nm>${t.counterparty}</Nm></Cdtr>`}</RltdPties>`
    : "";
  const remittance = t.refs?.length || t.ustrd ? `<RmtInf>${t.ustrd ? `<Ustrd>${t.ustrd}</Ustrd>` : ""}${(t.refs ?? []).map(strd).join("")}</RmtInf>` : "";
  const ret = t.returnReason ? `<RtrInf><Rsn><Cd>${t.returnReason}</Cd></Rsn></RtrInf>` : "";
  return `<TxDtls>${refs ? `<Refs>${refs}</Refs>` : ""}<AmtDtls><TxAmt>${money(t.amount)}</TxAmt></AmtDtls>${party}${remittance}${ret}</TxDtls>`;
}

export function camtFile(input: { messageId: string; account?: string; entries: CamtEntry[] }): string {
  const account = input.account ?? "5512348";
  const entries = input.entries
    .map(
      (e) =>
        `<Ntry>${money(e.amount)}<CdtDbtInd>${e.direction === "credit" ? "CRDT" : "DBIT"}</CdtDbtInd>${e.reversal ? "<RvslInd>true</RvslInd>" : ""}` +
        `<Sts>${e.status ?? "BOOK"}</Sts><BookgDt><Dt>${e.bookingDate}</Dt></BookgDt>${e.acctSvcrRef ? `<AcctSvcrRef>${e.acctSvcrRef}</AcctSvcrRef>` : ""}` +
        `<BkTxCd><Domn><Cd>PMNT</Cd><Fmly><Cd>NTAV</Cd><SubFmlyCd>NTAV</SubFmlyCd></Fmly></Domn></BkTxCd>` +
        `<NtryDtls>${e.txs.map((t) => tx(e, t)).join("")}</NtryDtls></Ntry>`
    )
    .join("");
  return (
    `<?xml version="1.0" encoding="UTF-8"?><Document xmlns="urn:iso:std:iso:20022:tech:xsd:camt.054.001.02"><BkToCstmrDbtCdtNtfctn>` +
    `<GrpHdr><MsgId>${input.messageId}</MsgId><CreDtTm>2024-10-09T18:00:00</CreDtTm></GrpHdr>` +
    `<Ntfctn><Id>${input.messageId}-1</Id><CreDtTm>2024-10-09T18:00:00</CreDtTm>` +
    `<Acct><Id><Othr><Id>${account}</Id><SchmeNm><Prtry>BGNR</Prtry></SchmeNm></Othr></Id><Ccy>SEK</Ccy></Acct>` +
    `${entries}</Ntfctn></BkToCstmrDbtCdtNtfctn></Document>`
  );
}
