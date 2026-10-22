import { SalesOrderCardPage } from "../../../../components/sales/SalesOrderCardPage";

export default async function SalesDocumentPage(props: { params: Promise<{ id: string }> }) {
  const { id } = await props.params;
  return <SalesOrderCardPage id={id} route="quote" />;
}
