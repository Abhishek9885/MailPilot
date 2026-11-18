import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Button } from "./button";
import { TextField } from "./field";
import { DataTable, type TableColumn } from "./table";
import { Pagination } from "./pagination";
import { EmptyState, ErrorState, LoadingSkeleton } from "./states";

describe("shared UI accessibility defaults", () => {
  it("keeps buttons named and non-submitting by default", () => {
    const markup = renderToStaticMarkup(createElement(Button, { "aria-label": "Open inbox" }, "Open"));

    expect(markup).toContain('type="button"');
    expect(markup).toContain('aria-label="Open inbox"');
  });

  it("associates field labels and validation messages with the input", () => {
    const markup = renderToStaticMarkup(createElement(TextField, {
      error: "Enter a recipient",
      id: "draft-recipient",
      label: "To"
    }));

    expect(markup).toContain('for="draft-recipient"');
    expect(markup).toContain('id="draft-recipient"');
    expect(markup).toContain('aria-describedby="draft-recipient-message"');
    expect(markup).toContain('aria-invalid="true"');
    expect(markup).toContain('role="alert"');
  });

  it("provides a caption and scoped column headers for data tables", () => {
    type Row = { id: string; subject: string };
    const columns: TableColumn<Row>[] = [
      { key: "subject", header: "Subject", render: (row) => row.subject }
    ];
    const markup = renderToStaticMarkup(createElement(DataTable<Row>, {
      caption: "Inbox messages",
      columns,
      rows: [{ id: "message-1", subject: "Hello" }]
    }));

    expect(markup).toContain("Inbox messages");
    expect(markup).toContain('<th scope="col">Subject</th>');
  });

  it("labels pagination controls and marks the current page", () => {
    const markup = renderToStaticMarkup(createElement(Pagination, {
      label: "Inbox pages",
      page: 2,
      pageCount: 3,
      onPageChange: () => undefined
    }));

    expect(markup).toContain('aria-label="Inbox pages"');
    expect(markup).toContain('aria-label="Page 2"');
    expect(markup).toContain('aria-current="page"');
  });

  it("announces empty, error, and loading states to assistive technology", () => {
    expect(renderToStaticMarkup(createElement(EmptyState, { title: "No messages", description: "Your inbox is clear." })))
      .toContain('role="status" aria-live="polite"');
    expect(renderToStaticMarkup(createElement(ErrorState, { description: "Please try again." })))
      .toContain('role="alert"');
    expect(renderToStaticMarkup(createElement(LoadingSkeleton)))
      .toContain('aria-busy="true"');
  });
});
