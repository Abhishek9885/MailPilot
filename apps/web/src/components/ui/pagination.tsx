import { Button } from "./button";

interface PaginationProps {
  label: string;
  page: number;
  pageCount: number;
  onPageChange: (page: number) => void;
}

export function Pagination({ label, page, pageCount, onPageChange }: PaginationProps) {
  if (pageCount <= 1) return null;

  return (
    <nav aria-label={label} className="pagination">
      <Button
        aria-label="Previous page"
        disabled={page <= 1}
        onClick={() => onPageChange(page - 1)}
        size="sm"
        variant="secondary"
      >
        Previous
      </Button>
      <ol className="pagination__pages">
        {Array.from({ length: pageCount }, (_, index) => index + 1).map((pageNumber) => (
          <li key={pageNumber}>
            <Button
              aria-current={page === pageNumber ? "page" : undefined}
              aria-label={`Page ${pageNumber}`}
              className={page === pageNumber ? "pagination__page pagination__page--current" : "pagination__page"}
              onClick={() => onPageChange(pageNumber)}
              size="sm"
              variant={page === pageNumber ? "primary" : "ghost"}
            >
              {pageNumber}
            </Button>
          </li>
        ))}
      </ol>
      <Button
        aria-label="Next page"
        disabled={page >= pageCount}
        onClick={() => onPageChange(page + 1)}
        size="sm"
        variant="secondary"
      >
        Next
      </Button>
    </nav>
  );
}
