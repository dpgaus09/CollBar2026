import { Switch, Route, Router as WouterRouter } from "wouter";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import NotFound from "@/pages/not-found";
import AdminPage from "@/pages/admin";
import LoginPage from "@/pages/login";
import AuthVerifyPage from "@/pages/auth-verify";
import DashboardIndexPage from "@/pages/dashboard/index";
import DistrictDashboardPage from "@/pages/dashboard/district";
import ClausesPage from "@/pages/dashboard/clauses";
import ComparablesPage from "@/pages/dashboard/comparables";
import AskVsGotPage from "@/pages/dashboard/ask-vs-got";
import ExpirationCalendarPage from "@/pages/expiration-calendar";
import PeerSetsPage from "@/pages/peer-sets";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      refetchOnWindowFocus: false,
    },
  },
});

function Home() {
  return (
    <div className="min-h-screen w-full flex items-center justify-center bg-slate-950">
      <div className="text-center space-y-4">
        <div className="flex items-center justify-center gap-3">
          <div className="w-2 h-2 rounded-full bg-blue-500" />
          <h1 className="text-3xl font-bold tracking-tight text-slate-100">CollBar</h1>
          <div className="w-2 h-2 rounded-full bg-blue-500" />
        </div>
        <p className="text-slate-400 text-sm font-mono">
          Ohio K-12 Collective Bargaining Database
        </p>
        <p className="text-slate-500 text-xs mt-6">Phase 4 — District Dashboard</p>
        <div className="mt-4 flex items-center justify-center gap-3">
          <a
            href="login"
            className="inline-flex items-center gap-2 px-4 py-2 rounded-md bg-blue-800 text-slate-100 text-sm hover:bg-blue-700 transition-colors border border-blue-700"
          >
            Sign In →
          </a>
          <a
            href="admin"
            className="inline-flex items-center gap-2 px-4 py-2 rounded-md bg-slate-800 text-slate-300 text-sm hover:bg-slate-700 transition-colors border border-slate-700"
          >
            Admin →
          </a>
        </div>
      </div>
    </div>
  );
}

function Router() {
  return (
    <Switch>
      <Route path="/" component={Home} />

      {/* Auth */}
      <Route path="/login" component={LoginPage} />
      <Route path="/auth/verify" component={AuthVerifyPage} />

      {/* Dashboard */}
      <Route path="/dashboard" component={DashboardIndexPage} />
      <Route path="/dashboard/:id" component={DistrictDashboardPage} />
      <Route path="/dashboard/:id/clauses" component={ClausesPage} />
      <Route path="/dashboard/:id/comparables" component={ComparablesPage} />
      <Route path="/dashboard/:id/ask-vs-got" component={AskVsGotPage} />

      {/* Peer sets */}
      <Route path="/peer-sets" component={PeerSetsPage} />

      {/* Admin calendar */}
      <Route path="/expiration-calendar" component={ExpirationCalendarPage} />

      {/* Legacy admin */}
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
        <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, "")}>
          <Router />
        </WouterRouter>
        <Toaster />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
