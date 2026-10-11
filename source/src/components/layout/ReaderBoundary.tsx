import { Component, type ReactNode } from 'react';
import { Button } from '@/components/ui/button';

/** A render fault must leave navigation and account controls usable. */
export class ReaderBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() {
    if (this.state.failed) return <div role="alert" className="m-6 surface-card p-6 space-y-4">
      <h2 className="text-lg font-semibold">This view could not finish loading.</h2>
      <p className="text-sm text-ink-dim">Your account and settings are still available. Try opening this view again.</p>
      <Button onClick={() => this.setState({ failed: false })}>Try again</Button>
    </div>;
    return this.props.children;
  }
}
