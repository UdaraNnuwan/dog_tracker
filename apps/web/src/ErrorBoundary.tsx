import { Component, type ErrorInfo, type ReactNode } from "react";

/** Shows a render error instead of a blank page, so problems are visible and reportable. */
export class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  override state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("render failed", error, info.componentStack);
  }

  override render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <main className="crash">
        <h2>Something went wrong</h2>
        <pre>{error.stack ?? error.message}</pre>
        <button type="button" onClick={() => location.reload()}>
          Reload
        </button>
      </main>
    );
  }
}
