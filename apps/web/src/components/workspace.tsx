"use client";

import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { DashboardOverview } from "@/components/dashboard-overview";
import { EmailDetail } from "@/components/email-detail";
import { SyncedEmailAnalysis } from "@/components/synced-email-analysis";
import { MailTable, MobileMailList } from "@/components/mail-list";
import { ActivityPage, AgentPage, ApprovalsPage, SettingsPage, TasksPage } from "@/components/remaining-pages";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { TextAreaField, TextField, SelectField } from "@/components/ui/field";
import { Icon, type IconName } from "@/components/ui/icon";
import { EmptyState, LoadingRows } from "@/components/ui/states";
import { Pagination } from "@/components/ui/pagination";
import { SignOutButton } from "@/components/sign-out-button";
import { APP_PATHS } from "@/lib/app-routes";
import { filterMail, paginateMail, summarizeInbox } from "@/lib/mail-utils";
import { MAIL_VIEW_CONTENT, MOCK_MAIL, type MailCategory, type MailFilter, type MailStatus, type MailView } from "@/lib/mock-mail";

const NAV_ITEMS: { key: MailView; label: string; icon: IconName }[] = [
  { key: "dashboard", label: "Dashboard", icon: "sparkles" },
  { key: "inbox", label: "Inbox", icon: "inbox" },
  { key: "agent", label: "Agent", icon: "sparkles" },
  { key: "approvals", label: "Approvals", icon: "approvals" },
  { key: "tasks", label: "Tasks", icon: "tasks" },
  { key: "activity", label: "Activity", icon: "clock" },
  { key: "drafts", label: "Drafts", icon: "drafts" },
  { key: "archive", label: "Archive", icon: "archive" },
  { key: "settings", label: "Settings", icon: "settings" }
];

const FILTERS: { key: MailFilter; label: string }[] = [
  { key: "all", label: "All" },
  { key: "unread", label: "Unread" },
  { key: "starred", label: "Starred" },
  { key: "priority", label: "Priority" }
];

function BrandMark() {
  return (
    <span aria-hidden="true" className="brand-mark">
      <svg fill="none" viewBox="0 0 32 32">
        <path d="M5.5 9.5 16 5l10.5 4.5v12L16 27 5.5 21.5v-12Z" stroke="currentColor" strokeWidth="1.8" />
        <path d="m8.5 11 7.5 5.5 7.5-5.5M11 20l3.4-3.5M21 20l-3.4-3.5" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" />
      </svg>
    </span>
  );
}

function Logo({ compact = false }: { compact?: boolean }) {
  return (
    <div className={`brand ${compact ? "brand--compact" : ""}`.trim()}>
      <BrandMark />
      {!compact && <span className="brand__name">MailPilot<span>AI</span></span>}
    </div>
  );
}

export default function Workspace({ initialView = "dashboard" }: { initialView?: MailView }) {
  const [activeView] = useState<MailView>(initialView);
  const [activeFilter, setActiveFilter] = useState<MailFilter>("all");
  const [categoryFilter, setCategoryFilter] = useState<MailCategory | "all">("all");
  const [statusFilter, setStatusFilter] = useState<MailStatus | "all">("all");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [selectedEmailId, setSelectedEmailId] = useState<string | null>(null);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [composerOpen, setComposerOpen] = useState(false);
  const [announcement, setAnnouncement] = useState("");
  const [starredIds, setStarredIds] = useState<string[]>(() => MOCK_MAIL.filter((item) => item.starred).map((item) => item.id));
  const firstNavRef = useRef<HTMLAnchorElement>(null);
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  const wasMobileNavOpenRef = useRef(false);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const refreshTimerRef = useRef<number | null>(null);
  const viewContent = MAIL_VIEW_CONTENT[activeView];
  const selectedEmail = useMemo(() => MOCK_MAIL.find((item) => item.id === selectedEmailId), [selectedEmailId]);

  const inboxItems = useMemo(() => MOCK_MAIL.filter((item) => item.view === "inbox"), []);
  const summary = useMemo(() => summarizeInbox(inboxItems), [inboxItems]);
  const viewItems = useMemo(() => activeView === "dashboard" || activeView === "agent" || activeView === "activity" || activeView === "settings"
    ? []
    : MOCK_MAIL.filter((item) => item.view === activeView), [activeView]);
  const filteredItems = useMemo(() => filterMail(viewItems, {
    query: search,
    filter: activeFilter,
    category: categoryFilter,
    status: statusFilter
  }, starredIds), [activeFilter, categoryFilter, search, starredIds, statusFilter, viewItems]);
  const currentPage = useMemo(() => paginateMail(filteredItems, page), [filteredItems, page]);
  const dashboardMatches = useMemo(() => filterMail(inboxItems, {
    query: search,
    filter: "all",
    category: "all",
    status: "all"
  }, starredIds), [inboxItems, search, starredIds]);
  const attentionItems = useMemo(() => dashboardMatches
    .filter((item) => item.priority === "urgent" || item.priority === "high" || item.status === "Needs reply")
    .sort((first, second) => new Date(second.dateTime).getTime() - new Date(first.dateTime).getTime()), [dashboardMatches]);
  const upcomingTasks = useMemo(() => MOCK_MAIL
    .filter((item) => item.view === "tasks")
    .sort((first, second) => new Date(first.dateTime).getTime() - new Date(second.dateTime).getTime()), []);
  const categories = useMemo(() => Array.from(new Set(viewItems.map((item) => item.category))).sort(), [viewItems]);
  const statuses = useMemo(() => Array.from(new Set(viewItems.map((item) => item.status))).sort(), [viewItems]);

  useEffect(() => {
    if (mobileNavOpen) {
      firstNavRef.current?.focus();
    } else if (wasMobileNavOpenRef.current) {
      menuButtonRef.current?.focus();
    }
    wasMobileNavOpenRef.current = mobileNavOpen;
  }, [mobileNavOpen]);

  useEffect(() => {
    const focusSearch = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== "k") return;
      event.preventDefault();
      document.getElementById("global-search")?.focus();
    };

    window.addEventListener("keydown", focusSearch);
    return () => window.removeEventListener("keydown", focusSearch);
  }, []);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (composerOpen && !dialog.open) dialog.showModal();
    if (!composerOpen && dialog.open) dialog.close();
  }, [composerOpen]);

  useEffect(() => () => {
    if (refreshTimerRef.current !== null) window.clearTimeout(refreshTimerRef.current);
  }, []);

  const setView = (view: MailView) => {
    setMobileNavOpen(false);
    window.location.assign(APP_PATHS[view]);
  };

  const clearFilters = () => {
    setSearch("");
    setActiveFilter("all");
    setCategoryFilter("all");
    setStatusFilter("all");
    setPage(1);
  };

  const toggleStar = (id: string) => {
    setStarredIds((current) => current.includes(id) ? current.filter((itemId) => itemId !== id) : [...current, id]);
  };

  const refreshMessages = () => {
    if (refreshTimerRef.current !== null) window.clearTimeout(refreshTimerRef.current);
    setIsRefreshing(true);
    setAnnouncement("Refreshing sample messages.");
    refreshTimerRef.current = window.setTimeout(() => {
      setIsRefreshing(false);
      setAnnouncement("Sample messages are up to date.");
      refreshTimerRef.current = null;
    }, 450);
  };

  const closeMobileNav = () => setMobileNavOpen(false);

  const saveDraft = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setComposerOpen(false);
    setAnnouncement("Draft saved in this demo. No email was sent.");
  };

  const countForView = (view: MailView): number | undefined => {
    if (view === "dashboard" || view === "agent" || view === "activity" || view === "settings") return undefined;
    if (view === "inbox") return inboxItems.filter((item) => item.unread).length;
    if (view === "tasks") return MOCK_MAIL.filter((item) => item.view === view && item.status !== "Complete").length;
    return MOCK_MAIL.filter((item) => item.view === view).length;
  };

  const timeHeading = activeView === "tasks" ? "Due" : activeView === "drafts" || activeView === "approvals" ? "Updated" : "Received";

  return (
    <div className="app-shell">
      <a className="skip-link" href="#main-content">Skip to main content</a>

      <aside
        aria-label={mobileNavOpen ? "Application navigation" : "Application sidebar"}
        aria-modal={mobileNavOpen ? true : undefined}
        className={mobileNavOpen ? "sidebar sidebar--open" : "sidebar"}
        id="application-sidebar"
        role={mobileNavOpen ? "dialog" : undefined}
        onKeyDown={(event) => {
          if (!mobileNavOpen) return;
          if (event.key === "Escape") {
            closeMobileNav();
            return;
          }
          if (event.key !== "Tab") return;
          const focusableItems = event.currentTarget.querySelectorAll<HTMLElement>("a[href], button:not([disabled])");
          const firstItem = focusableItems.item(0);
          const lastItem = focusableItems.item(focusableItems.length - 1);
          if (event.shiftKey && document.activeElement === firstItem) {
            event.preventDefault();
            lastItem?.focus();
          } else if (!event.shiftKey && document.activeElement === lastItem) {
            event.preventDefault();
            firstItem?.focus();
          }
        }}
      >
        <div className="sidebar__brand"><Logo /></div>
        <div className="workspace-switcher">
          <span aria-hidden="true" className="workspace-switcher__avatar">A</span>
          <span className="workspace-switcher__copy"><strong>Acme Studio</strong><small>Personal workspace</small></span>
          <span aria-hidden="true" className="workspace-switcher__chevron">⌄</span>
        </div>

        <nav aria-label="Primary navigation" className="primary-nav" id="primary-navigation">
          <p className="nav-section-label">Workspace</p>
          {NAV_ITEMS.map((item, index) => (
            <a
              aria-current={activeView === item.key ? "page" : undefined}
              className={activeView === item.key ? "nav-item nav-item--active" : "nav-item"}
              href={APP_PATHS[item.key]}
              key={item.key}
              onClick={() => setMobileNavOpen(false)}
              ref={index === 0 ? firstNavRef : undefined}
            >
              <Icon name={item.icon} size={18} />
              <span className="nav-item__label">{item.label}</span>
              {countForView(item.key) !== undefined && <span className="nav-item__count">{countForView(item.key)}</span>}
            </a>
          ))}
        </nav>

        <div className="sidebar__bottom">
          <div className="privacy-note">
            <span aria-hidden="true" className="privacy-note__mark"><Icon name="approvals" size={16} /></span>
            <span><strong>You stay in control</strong><small>Review every action first</small></span>
          </div>
          <div className="sidebar-profile">
            <span aria-hidden="true" className="sidebar-profile__avatar">AM</span>
            <span className="sidebar-profile__copy"><strong>Alex Morgan</strong><small>Demo account</small></span>
          </div>
          <SignOutButton />
        </div>
      </aside>

      {mobileNavOpen && <button aria-label="Close navigation menu" className="sidebar-backdrop" onClick={closeMobileNav} tabIndex={-1} type="button" />}

      <div className="workspace-main" inert={mobileNavOpen}>
        <header className="topbar">
          <div className="topbar__leading">
            <Button
              aria-controls="application-sidebar"
              aria-expanded={mobileNavOpen}
              aria-label={mobileNavOpen ? "Close navigation menu" : "Open navigation menu"}
              className="mobile-menu-button"
              onClick={() => setMobileNavOpen((open) => !open)}
              ref={menuButtonRef}
              variant="icon"
            >
              <Icon name={mobileNavOpen ? "close" : "menu"} size={20} />
            </Button>
            <div className="mobile-brand"><Logo compact /></div>
            <form aria-label="Search mail" className="global-search" onSubmit={(event) => event.preventDefault()} role="search">
              <TextField
                autoComplete="off"
                className="global-search__input"
                id="global-search"
                label="Search mail"
                labelHidden
                leadingIcon={<Icon name="search" size={18} />}
                onChange={(event) => { setSearch(event.currentTarget.value); setPage(1); }}
                placeholder="Search sender, subject, or keyword"
                type="search"
                value={search}
              />
              <kbd aria-hidden="true" className="search-shortcut">Ctrl / ⌘ K</kbd>
            </form>
          </div>
          <div className="topbar__actions">
            <Button
              aria-label="Open pending approvals"
              className="notification-button"
              onClick={() => setView("approvals")}
              variant="icon"
            >
              <Icon name="bell" size={19} />
              <span aria-hidden="true" className="notification-dot" />
            </Button>
            <span aria-hidden="true" className="topbar-divider" />
            <div className="topbar-profile">
              <span aria-hidden="true" className="topbar-profile__avatar">AM</span>
              <span className="topbar-profile__name">Alex Morgan</span>
            </div>
          </div>
        </header>

        <main className="app-main" id="main-content" tabIndex={-1}>
          <div aria-live="polite" className="visually-hidden">{announcement}</div>
          <div className="page-heading">
            <div>
              <div className="page-eyebrow">
                <span aria-hidden="true" className="demo-indicator" />
                {selectedEmail ? <>Inbox <span className="eyebrow-separator">/</span> Conversation</> : <>Demo workspace <span className="eyebrow-separator">/</span> Sample data</>}
              </div>
              <h1>{selectedEmail?.subject ?? viewContent.title}</h1>
              <p>{selectedEmail ? `Conversation with ${selectedEmail.sender} · ${selectedEmail.timeLabel}` : viewContent.description}</p>
            </div>
            {selectedEmail ? (
              <Button onClick={() => setSelectedEmailId(null)} variant="secondary">Back to {activeView === "inbox" ? "inbox" : "messages"}</Button>
            ) : (
              <Button onClick={() => setComposerOpen(true)}>
                <Icon name="plus" size={18} />
                Compose
              </Button>
            )}
          </div>

          {!selectedEmail && (activeView === "dashboard" || activeView === "inbox") && <p className="mock-data-banner">Sample preview · {summary.total} sample messages · Stored mailbox data stays separate</p>}

          {selectedEmail ? (
            <EmailDetail item={selectedEmail} key={selectedEmail.id} />
          ) : activeView === "agent" ? (
            <AgentPage onViewApprovals={() => setView("approvals")} onViewTasks={() => setView("tasks")} />
          ) : activeView === "approvals" ? (
            <ApprovalsPage />
          ) : activeView === "tasks" ? (
            <TasksPage onOpenEmail={setSelectedEmailId} />
          ) : activeView === "activity" ? (
            <ActivityPage onOpenEmail={setSelectedEmailId} />
          ) : activeView === "settings" ? (
            <SettingsPage />
          ) : activeView === "dashboard" ? (
            <DashboardOverview
              attentionItems={attentionItems}
              onClearSearch={() => setSearch("")}
              onViewInbox={() => setView("inbox")}
              onViewTasks={() => setView("tasks")}
              searchQuery={search}
              summary={summary}
              upcomingTasks={upcomingTasks}
            />
          ) : (
            <>
              {activeView === "inbox" && (
                <>
                  <SyncedEmailAnalysis />
                  <div className="stats-grid stats-grid--inbox">
                    <Card className="inbox-count-card"><span>Sample inbox messages</span><strong>{summary.total}</strong></Card>
                    <Card className="inbox-count-card"><span>Unread</span><strong>{summary.unread}</strong></Card>
                    <Card className="inbox-count-card"><span>High priority</span><strong>{summary.highPriority}</strong></Card>
                    <Card className="inbox-count-card"><span>Needs reply</span><strong>{summary.needsReply}</strong></Card>
                  </div>
                </>
              )}

              <Card aria-labelledby="mail-list-title" className="mail-card inbox-card">
                <div className="mail-card__header">
                  <div>
                    <div className="mail-card__title-row">
                      <h2 id="mail-list-title">{viewContent.title}</h2>
                      <Badge tone="neutral">{filteredItems.length}</Badge>
                    </div>
                    <p>{activeView === "inbox" ? "Sender, subject, priority, status, and received time at a glance." : `Sample ${viewContent.title.toLowerCase()} for this demo workspace.`}</p>
                  </div>
                  <Button
                    aria-label="Refresh sample messages"
                    className="refresh-button"
                    disabled={isRefreshing}
                    onClick={refreshMessages}
                    variant="icon"
                  >
                    <Icon name="refresh" size={18} />
                  </Button>
                </div>

                <div className="inbox-controls">
                  <div aria-label="Filter messages" className="mail-filters" role="group">
                    {FILTERS.map((filter) => (
                      <button
                        aria-pressed={activeFilter === filter.key}
                        className={activeFilter === filter.key ? "filter-chip filter-chip--active" : "filter-chip"}
                        key={filter.key}
                        onClick={() => { setActiveFilter(filter.key); setPage(1); }}
                        type="button"
                      >
                        {filter.label}
                      </button>
                    ))}
                  </div>
                  <div className="inbox-select-filters">
                    <SelectField
                      className="inbox-filter-select"
                      id="category-filter"
                      label="Category"
                      labelHidden
                      onChange={(event) => { setCategoryFilter(event.currentTarget.value as MailCategory | "all"); setPage(1); }}
                      value={categoryFilter}
                    >
                      <option value="all">All categories</option>
                      {categories.map((category) => <option key={category} value={category}>{category}</option>)}
                    </SelectField>
                    <SelectField
                      className="inbox-filter-select"
                      id="status-filter"
                      label="Status"
                      labelHidden
                      onChange={(event) => { setStatusFilter(event.currentTarget.value as MailStatus | "all"); setPage(1); }}
                      value={statusFilter}
                    >
                      <option value="all">All statuses</option>
                      {statuses.map((status) => <option key={status} value={status}>{status}</option>)}
                    </SelectField>
                  </div>
                </div>

                {isRefreshing ? (
                  <LoadingRows label="Refreshing sample messages" rows={6} />
                ) : filteredItems.length > 0 ? (
                  <>
                    <div className="desktop-mail-table">
                      <MailTable
                        caption={`${viewContent.title} sample email messages`}
                        items={currentPage.items}
                        onOpenEmail={setSelectedEmailId}
                        onToggleStar={toggleStar}
                        starredIds={starredIds}
                        timeHeading={timeHeading}
                      />
                    </div>
                    <div className="mobile-mail-table">
                      <MobileMailList items={currentPage.items} onOpenEmail={setSelectedEmailId} onToggleStar={toggleStar} starredIds={starredIds} />
                    </div>
                    <div className="mail-card__footer inbox-card__footer">
                      <span aria-live="polite">Showing {currentPage.start}–{currentPage.end} of {currentPage.total} messages</span>
                      <span className="mock-data-note"><span aria-hidden="true" className="mock-data-note__dot" />Sample data only</span>
                    </div>
                    <Pagination label={`${viewContent.title} pages`} onPageChange={setPage} page={currentPage.page} pageCount={currentPage.pageCount} />
                  </>
                ) : (
                  <>
                    <EmptyState
                      action={(search || activeFilter !== "all" || categoryFilter !== "all" || statusFilter !== "all")
                        ? <Button onClick={clearFilters} variant="secondary">Clear search and filters</Button>
                        : undefined}
                      description={search || activeFilter !== "all" || categoryFilter !== "all" || statusFilter !== "all"
                        ? "Try another search or clear the filters to see more sample messages."
                        : "When a conversation arrives, it will appear here."}
                      icon="mail"
                      title={search || activeFilter !== "all" || categoryFilter !== "all" || statusFilter !== "all"
                        ? "No matching messages"
                        : viewContent.emptyTitle}
                    />
                    <div className="mail-card__footer">
                      <span>No messages to show</span>
                      <span className="mock-data-note"><span aria-hidden="true" className="mock-data-note__dot" />Sample data only</span>
                    </div>
                  </>
                )}
              </Card>
            </>
          )}

          <footer className="app-footer"><span>MailPilot AI</span><span>Preview workspace · No mail service connected</span></footer>
        </main>
      </div>

      <dialog
        aria-labelledby="compose-title"
        className="compose-dialog"
        onCancel={() => setComposerOpen(false)}
        onClose={() => setComposerOpen(false)}
        ref={dialogRef}
      >
        <div className="compose-dialog__header">
          <div><span className="compose-dialog__eyebrow">Demo only</span><h2 id="compose-title">New draft</h2></div>
          <Button aria-label="Close draft form" onClick={() => setComposerOpen(false)} variant="icon"><Icon name="close" size={20} /></Button>
        </div>
        <p className="compose-dialog__note">This form is a UI preview. Saving keeps the action local; it will not send email.</p>
        <form className="compose-form" onSubmit={saveDraft}>
          <TextField autoComplete="email" id="draft-recipient" label="To" placeholder="name@example.com" required type="email" />
          <TextField id="draft-subject" label="Subject" placeholder="Add a subject" required />
          <TextAreaField id="draft-body" label="Message" placeholder="Write a message…" required rows={5} />
          <div className="compose-form__actions">
            <Button onClick={() => setComposerOpen(false)} variant="secondary">Cancel</Button>
            <Button type="submit"><Icon name="drafts" size={17} /> Save draft</Button>
          </div>
        </form>
      </dialog>
    </div>
  );
}
