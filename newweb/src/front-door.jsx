import React from 'react';
import { FeedbackDialog, FooterLinks, InstallGuide } from './pwa-ui.jsx';
import { routeHash } from './routes.mjs';

// Front door (EXPERIENCE.md "Release layout, locked"): identity, one factual line, Seal files, Verify files, Try a sample.
// Nothing here changes on a timer. Plain hash links keep Back/Forward and the route focus rule.
export function SkipLink({ targetId = 'main' }) {
  return <a className="skip-link" href={`#${targetId}`} onClick={(event) => { event.preventDefault(); document.getElementById(targetId)?.focus(); }}>Skip to content</a>;
}

export function FrontDoor({ notice, sampleHref, installKind, onInstall, onFeedback, installOpen, onInstallClose, feedbackOpen, onFeedbackClose, route }) {
  return <div className="landing-page front-door">
    <SkipLink />
    <main id="main" className="landing-main front-door-main" tabIndex="-1">
      {notice}
      <section className="front-door-hero" aria-labelledby="page-landing">
        <div className="front-door-identity"><span className="brand-mark" aria-hidden="true">H</span><h1 id="page-landing" tabIndex="-1">HashWing</h1></div>
        <p className="front-door-value">Seal files on this device and let your client check them.</p>
        <div className="front-door-actions">
          <a className="button primary" href={routeHash('protect')}>Seal files</a>
          <a className="button secondary" href={routeHash('verify')}>Verify files</a>
          <a className="front-door-sample" href={sampleHref}>Try a sample</a>
        </div>
        <p className="front-door-note">Files stay on this device. <a href={routeHash('help')}>How checking works</a></p>
      </section>
    </main>
    <FooterLinks onFeedback={onFeedback} onInstall={onInstall}>
      <a href="#/login">Use a local profile</a><a href="https://github.com/anirudh763/flightseal" target="_blank" rel="noreferrer">Source</a>
    </FooterLinks>
    <InstallGuide open={installOpen} onClose={onInstallClose} ios={installKind === 'ios'} />
    <FeedbackDialog open={feedbackOpen} onClose={onFeedbackClose} route={route} />
  </div>;
}
