const caffeine = document.querySelector('#caffeine');
caffeine.addEventListener('change', () => {
  const labels = {unknown: 'Unknown', present: 'Present', absent: 'Explicitly absent'};
  document.querySelector('#correction').textContent = caffeine.value === 'unknown'
    ? 'Unknown retained. No negative observation was inferred.'
    : `Preview: human correction → ${labels[caffeine.value]}. Original proposal retained; dependent evidence marked stale. Not saved.`;
});
const messages = {
  yes: 'Caffeine confirmed. Next question: was it after noon? Adherence remains unknown until timing is resolved; travel stays flagged.',
  no: 'Tea is caffeine-free. Timing is no longer needed for that drink. Adherence remains unknown until the full-day log is confirmed; travel stays flagged.',
  unknown: 'Keep adherence unknown. No further question now. Retain the day and the travel flag in the observation ledger.'
};
document.querySelectorAll('[data-tea]').forEach(button => {
  button.setAttribute('aria-pressed', 'false');
  button.addEventListener('click', () => {
    document.querySelectorAll('[data-tea]').forEach(other => other.setAttribute('aria-pressed', String(other === button)));
    document.querySelector('#tea-result').textContent = messages[button.dataset.tea];
  });
});
const links = [...document.querySelectorAll('nav a')];
const observer = new IntersectionObserver(entries => {
  for (const entry of entries) if (entry.isIntersecting) {
    links.forEach(link => {
      const active = link.hash === `#${entry.target.id}`;
      link.classList.toggle('active', active);
      if (active) link.setAttribute('aria-current', 'location');
      else link.removeAttribute('aria-current');
    });
  }
}, {rootMargin: '-10% 0px -65% 0px'});
document.querySelectorAll('main section').forEach(section => observer.observe(section));
