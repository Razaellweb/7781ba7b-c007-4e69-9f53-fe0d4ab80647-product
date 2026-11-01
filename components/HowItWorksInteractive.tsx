"use client";

import { useState } from "react";

const questions = [
  {
    id: "verify",
    number: "01",
    label: "Sign in with Privy",
    eyebrow: "ENTRY",
    title: "Start with a verified identity.",
    body: "Privy authenticates your identity and that verified session is the access requirement. No new password, provider account, API key, or token-holding check is added to the path.",
    detail: "Identity stays explicit from the first step.",
  },
  {
    id: "receive",
    number: "02",
    label: "Receive compute",
    eyebrow: "ALLOWANCE",
    title: "A verified session becomes a recurring allowance.",
    body: "Authenticated accounts receive internal USD compute for approved model access. Grants are recorded for the relevant period and do not silently duplicate or imply unlimited usage.",
    detail: "A clear balance replaces a complicated subscription flow.",
  },
  {
    id: "choose",
    number: "03",
    label: "Choose a model",
    eyebrow: "SELECTION",
    title: "Pick a frontier, or let Auto decide.",
    body: "Use a curated open-weight model or choose Auto from the reviewed registry. The workspace keeps model and provider complexity behind one simple conversation.",
    detail: "Curated access, without a marketplace to navigate.",
  },
  {
    id: "think",
    number: "04",
    label: "Think openly",
    eyebrow: "WORKSPACE",
    title: "The conversation stays simple.",
    body: "Submit a prompt and receive a streamed response while Openweight tracks usage in the background. Reservations and settlement keep each request accountable as it runs.",
    detail: "Open-weight intelligence, unlocked by a verified session.",
  },
];

export default function HowItWorksInteractive() {
  const [activeId, setActiveId] = useState(questions[0].id);
  const activeQuestion = questions.find((question) => question.id === activeId) ?? questions[0];

  const activateQuestion = (id: string) => {
    if (id !== activeId) setActiveId(id);
  };

  return (
    <section className="landing-how-interactive" id="how-it-works" aria-labelledby="landing-how-interactive-heading">
      <div className="landing-how-interactive-inner">
        <div className="landing-how-interactive-heading">
          <div>
            <span className="landing-how-interactive-label">// HOW IT WORKS / THE SHORT VERSION</span>
            <h2 id="landing-how-interactive-heading">ACCESS, WITHOUT THE FRICTION.</h2>
          </div>
          <p>One clear sequence turns a verified identity into a simple, accountable way to use curated open-weight intelligence.</p>
        </div>

        <div className="landing-how-interactive-layout">
          <nav className="landing-how-questions" aria-label="How it works questions">
            <span className="landing-how-questions-label">THE SEQUENCE</span>
            <div className="landing-how-question-list">
              {questions.map((question) => {
                const isActive = question.id === activeQuestion.id;
                return (
                  <button
                    className={`landing-how-question${isActive ? " is-active" : ""}`}
                    key={question.id}
                    type="button"
                    aria-current={isActive ? "step" : undefined}
                    aria-controls="landing-how-answer"
                    onFocus={() => activateQuestion(question.id)}
                    onClick={() => activateQuestion(question.id)}
                  >
                    <span className="landing-how-question-number">{question.number}</span>
                    <span className="landing-how-question-label">{question.label}</span>
                    <span className="landing-how-question-arrow" aria-hidden="true">\u2197</span>
                  </button>
                );
              })}
            </div>
            <p className="landing-how-question-hint">Select a question to move through the system.</p>
          </nav>

          <div className="landing-how-viewport" id="landing-how-answer" role="region" aria-live="polite" aria-labelledby="landing-how-answer-title">
            <div className="landing-how-viewport-top">
              <span>{activeQuestion.eyebrow}</span>
              <span>{activeQuestion.number} / {questions.length.toString().padStart(2, "0")}</span>
            </div>
            <div className="landing-how-answer">
              <span className="landing-how-answer-mark" aria-hidden="true">\u2726</span>
              <h3 id="landing-how-answer-title">{activeQuestion.title}</h3>
              <p>{activeQuestion.body}</p>
            </div>
            <div className="landing-how-viewport-foot">
              <span>{activeQuestion.detail}</span>
              <span className="landing-how-live-dot" aria-hidden="true" />
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
