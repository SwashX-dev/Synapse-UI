parent.postMessage({ type: 'subscribe', sources: ['cpu.load'] }, '*');
window.addEventListener('message', event => {
  if (event.source !== parent || event.data?.type !== 'data') return;
  const value = event.data.values?.['cpu.load'];
  document.querySelector('#value').textContent = typeof value === 'number' ? value.toFixed(1) + '%' : 'n/a';
  document.querySelector('#meter').value = typeof value === 'number' ? value : 0;
});
