import { Switch, Route, Router as WouterRouter } from "wouter";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import NotFound from "@/pages/not-found";
import AdminPage from "@/pages/admin";
import LoginPage from "@/pages/login";
import FirmSignupPage from "@/pages/firm/signup";
import AcceptInvitePage from "@/pages/firm/accept-invite";
import AppHomePage from "@/pages/app/index";
import RosterPage from "@/pages/app/roster";
import MattersPage from "@/pages/app/matters";
import MatterDetailPage from "@/pages/app/matter-detail";
import ComparePage from "@/pages/app/compare";
import DashboardIndexPage from "@/pages/dashboard/index";
import DistrictDashboardPage from "@/pages/dashboard/district";
import ClausesPage from "@/pages/dashboard/clauses";
import ComparablesPage from "@/pages/dashboard/comparables";
import AskVsGotPage from "@/pages/dashboard/ask-vs-got";
import FinalOffersPage from "@/pages/dashboard/final-offers";
import AskPage from "@/pages/dashboard/ask";
import ToolkitPage from "@/pages/dashboard/toolkit";
import SubmitDocumentsPage from "@/pages/dashboard/submit";
import ExpirationCalendarPage from "@/pages/expiration-calendar";
import PeerSetsPage from "@/pages/peer-sets";
import PlansPage from "@/pages/plans";
import TrackerPage from "@/pages/tracker";
import { UpgradeLockProvider } from "@/components/upgrade";
import { LifeBuoy } from "lucide-react";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      refetchOnWindowFocus: false,
    },
  },
});

function Home() {
  return (
    <main className="min-h-screen w-full flex items-center justify-center bg-slate-950">
      <div className="text-center space-y-4">
        <div className="flex items-center justify-center gap-3">
          <div className="w-2 h-2 rounded-full bg-blue-500" />
          <h1 className="text-3xl font-bold tracking-tight text-slate-100">CollBar</h1>
          <div className="w-2 h-2 rounded-full bg-blue-500" />
        </div>
        <p className="text-slate-400 text-sm font-mono">
          Collective Bargaining Database
        </p>
        <p className="text-slate-500 text-xs mt-6">District Dashboard</p>
        <div className="mt-4 flex items-center justify-center gap-3">
          <a
            href={`${import.meta.env.BASE_URL}login`}
            className="inline-flex items-center gap-2 px-4 py-2 rounded-md bg-blue-800 text-slate-100 text-sm hover:bg-blue-700 transition-colors border border-blue-700"
          >
            Sign In →
          </a>
        </div>
        <p className="mx-auto mt-6 max-w-sm text-sm leading-relaxed text-slate-400">
          Districts like yours settled their teacher contracts this spring. See
          exactly what they paid.
        </p>
      </div>
    </main>
  );
}

function Router() {
  return (
    <Switch>
      <Route path="/" component={Home} />

      {/* Public */}
      <Route path="/tracker" component={TrackerPage} />
      <Route path="/plans" component={PlansPage} />

      {/* Auth */}
      <Route path="/login" component={LoginPage} />
      <Route path="/signup" component={FirmSignupPage} />
      <Route path="/invite/accept" component={AcceptInvitePage} />

      {/* Firm workspace */}
      <Route path="/app" component={AppHomePage} />
      <Route path="/app/roster" component={RosterPage} />
      <Route path="/app/matters" component={MattersPage} />
      <Route path="/app/matters/:id" component={MatterDetailPage} />
      <Route path="/app/compare" component={ComparePage} />

      {/* Toolkit (free + paid + admin) */}
      <Route path="/toolkit" component={ToolkitPage} />

      {/* Dashboard */}
      <Route path="/dashboard" component={DashboardIndexPage} />
      <Route path="/dashboard/ask" component={AskPage} />
      <Route path="/dashboard/:id" component={DistrictDashboardPage} />
      <Route path="/dashboard/:id/clauses" component={ClausesPage} />
      <Route path="/dashboard/:id/comparables" component={ComparablesPage} />
      <Route path="/dashboard/:id/ask-vs-got" component={AskVsGotPage} />
      <Route path="/dashboard/:id/final-offers" component={FinalOffersPage} />
      <Route path="/dashboard/:id/submit" component={SubmitDocumentsPage} />

      {/* Peer sets */}
      <Route path="/peer-sets" component={PeerSetsPage} />

      {/* Admin calendar */}
      <Route path="/expiration-calendar" component={ExpirationCalendarPage} />

      {/* Admin */}
      <Route path="/admin" component={AdminPage} />
      <Route path="/admin/:rest*" component={AdminPage} />

      <Route component={NotFound} />
    </Switch>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <UpgradeLockProvider>
          {/* 2.4.1 Bypass Blocks: first tab stop moves keyboard focus into the
              current page's <main> landmark (rendered after each page's nav),
              skipping the repeated navigation. Focus is transferred explicitly
              because fragment navigation alone is unreliable across browsers. */}
          <a
            href="#main-content"
            className="skip-link"
            onClick={(e) => {
              const main = document.querySelector("main");
              if (main) {
                e.preventDefault();
                if (!main.id) main.id = "main-content";
                main.setAttribute("tabindex", "-1");
                (main as HTMLElement).focus();
              }
            }}
          >
            Skip to main content
          </a>
          <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, "")}>
            <Router />
          </WouterRouter>
          {/* 3.2.6 Consistent Help: rendered once here so the help affordance
              appears in the same place and DOM order on every page. */}
          <a
            href="mailto:hello@collbar.com"
            aria-label="Get help — email CollBar support"
            className="fixed bottom-3 right-3 z-40 inline-flex items-center gap-1.5 min-h-9 rounded-full border border-slate-700 bg-slate-900/95 px-3.5 py-2 text-xs font-medium text-slate-200 shadow-lg hover:bg-slate-800 transition-colors"
          >
            <LifeBuoy className="h-4 w-4" aria-hidden="true" />
            <span>Help</span>
          </a>
        </UpgradeLockProvider>
        <Toaster />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
