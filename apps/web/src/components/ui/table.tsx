import type { ReactNode } from "react";

export interface TableColumn<Row> {
  key: string;
  header: string;
  headerClassName?: string;
  cellClassName?: string;
  render: (row: Row) => ReactNode;
}

interface DataTableProps<Row extends { id: string }> {
  caption: string;
  columns: TableColumn<Row>[];
  rows: Row[];
  rowClassName?: (row: Row) => string | undefined;
}

export function DataTable<Row extends { id: string }>({
  caption,
  columns,
  rows,
  rowClassName
}: DataTableProps<Row>) {
  return (
    <div aria-label={caption} className="table-scroll" role="region" tabIndex={0}>
      <table className="data-table">
        <caption className="visually-hidden">{caption}</caption>
        <thead>
          <tr>
            {columns.map((column) => (
              <th className={column.headerClassName} key={column.key} scope="col">{column.header}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr className={rowClassName?.(row)} key={row.id}>
              {columns.map((column) => (
                <td className={column.cellClassName} key={column.key}>{column.render(row)}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
