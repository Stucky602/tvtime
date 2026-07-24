import { Component } from 'react';

// Resilience: one component throwing used to blank the entire app.
//
// React unmounts the whole tree on an unhandled render error, so a bad
// title row or a malformed date could take down everything and leave a
// white screen with the cause only in a console nobody is looking at on
// a phone. This catches it, keeps the app on screen, and offers the two
// recoveries that actually work.
//
// Class component because error boundaries have no hooks equivalent --
// there is still no useErrorBoundary.

export default class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    console.error('FlixPix crashed:', error, info?.componentStack);
  }

  render() {
    if (!this.state.error) return this.props.children;

    return (
      <div className="app">
        <div className="onboard-screen">
          <h1 className="brand">Ouch</h1>
          <p className="onboard-sub">
            Something broke on this screen. Nothing you did — and nothing you've
            swiped is lost.
          </p>
          <button
            className="onboard-btn onboard-btn--primary"
            onClick={() => this.setState({ error: null })}
          >
            Try again
          </button>
          <button
            className="onboard-btn"
            onClick={() => {
              // Clears the cached deck and any in-session state, which
              // covers the "some cached data is malformed" case that a
              // plain retry cannot.
              try {
                sessionStorage.clear();
              } catch {
                /* ignore */
              }
              window.location.reload();
            }}
          >
            Reset and reload
          </button>
          <details className="crash-detail">
            <summary>Technical detail</summary>
            <pre>{String(this.state.error?.message || this.state.error)}</pre>
          </details>
        </div>
      </div>
    );
  }
}
