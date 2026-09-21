import { api, auth } from '../api.js';
import { el, toast, toastError, debounce } from '../ui.js';

/** Renders the sign-in / sign-up screen. Resolves once a session exists. */
export function authView(root, onSuccess) {
  let mode = 'login';

  const card = el('div', { class: 'auth-card' });
  root.replaceChildren(el('div', { class: 'auth-wrap' }, card));

  function render() {
    const isLogin = mode === 'login';

    const email = el('input', { class: 'input', type: 'email', autocomplete: 'email', placeholder: 'you@example.com', required: true });
    const password = el('input', { class: 'input', type: 'password', autocomplete: isLogin ? 'current-password' : 'new-password', placeholder: '••••••••', required: true });
    const name = el('input', { class: 'input', type: 'text', autocomplete: 'name', placeholder: 'Your name', maxlength: '60' });
    const incomeInput = el('input', { class: 'input', type: 'number', min: '0', step: '500', placeholder: '45000' });

    const meter = el('div', { class: 'strength' }, el('span'), el('span'), el('span'), el('span'));
    const meterTip = el('div', { class: 'strength-tip' });
    const errorBox = el('div', { class: 'field-error', hidden: true, style: 'margin-bottom:1rem' });
    const submit = el('button', { class: 'btn btn-primary btn-block', type: 'submit' }, isLogin ? 'Sign in' : 'Create account');

    // Strength feedback is local — no need to ask the server on every keystroke.
    if (!isLogin) {
      password.addEventListener('input', debounce(() => {
        const v = password.value;
        let score = 0;
        const tips = [];
        if (v.length >= 8) score++; else tips.push('at least 8 characters');
        if (v.length >= 12) score++; else if (v.length >= 8) tips.push('12+ is stronger');
        if (/[a-z]/.test(v) && /[A-Z]/.test(v)) score++; else tips.push('mix upper and lower case');
        if (/\d/.test(v)) score++; else tips.push('add a digit');
        if (/[^A-Za-z0-9]/.test(v)) score++; else tips.push('add a symbol');
        meter.className = `strength s${Math.min(4, score)}`;
        meterTip.textContent = v ? (score >= 3 ? 'Good password' : `Try: ${tips.slice(0, 2).join(', ')}`) : '';
      }, 160));
    }

    const form = el('form', {
      onsubmit: async (e) => {
        e.preventDefault();
        errorBox.hidden = true;
        submit.disabled = true;
        submit.textContent = isLogin ? 'Signing in…' : 'Creating account…';

        try {
          const payload = isLogin
            ? { email: email.value.trim(), password: password.value }
            : { email: email.value.trim(), password: password.value, name: name.value.trim() || 'There', monthlyIncome: Number(incomeInput.value) || 0 };

          const res = await api.post(isLogin ? '/api/auth/login' : '/api/auth/register', payload);
          auth.token = res.token;
          toast(isLogin ? `Welcome back, ${res.user.name}` : `Welcome to FinTrack, ${res.user.name}`, { type: 'success', timeout: 3000 });
          onSuccess(res.user);
        } catch (err) {
          errorBox.textContent = Array.isArray(err.details) ? err.details.join(' · ') : err.message;
          errorBox.hidden = false;
          submit.disabled = false;
          submit.textContent = isLogin ? 'Sign in' : 'Create account';
        }
      }
    },
      errorBox,
      isLogin ? null : el('div', { class: 'field' }, el('label', { text: 'Name' }), name),
      el('div', { class: 'field' }, el('label', { text: 'Email' }), email),
      el('div', { class: 'field' },
        el('label', { text: 'Password' }), password,
        isLogin ? null : meter, isLogin ? null : meterTip
      ),
      isLogin ? null : el('div', { class: 'field' },
        el('label', { text: 'Monthly income (optional)' }), incomeInput,
        el('div', { class: 'strength-tip', text: 'Used for your savings rate and health score. You can set it later.' })
      ),
      submit
    );

    card.replaceChildren(
      el('div', { class: 'auth-brand' }, el('span', { text: '💰' }), 'FinTrack'),
      el('div', { class: 'auth-sub', text: 'Expense tracking that forecasts, spots outliers and finds the subscriptions you forgot about.' }),
      el('div', { class: 'auth-tabs' },
        el('button', { class: isLogin ? 'active' : '', type: 'button', onclick: () => { mode = 'login'; render(); } }, 'Sign in'),
        el('button', { class: !isLogin ? 'active' : '', type: 'button', onclick: () => { mode = 'register'; render(); } }, 'Create account')
      ),
      form,
      isLogin
        ? el('div', { class: 'demo-hint' },
            'Try the demo account — it comes with 9 months of history: ',
            el('b', { text: 'demo@fintrack.app' }), ' / ', el('b', { text: 'Demo@1234' }),
            el('button', {
              class: 'btn btn-sm', style: 'margin-top:.6rem;width:100%',
              type: 'button',
              onclick: () => { email.value = 'demo@fintrack.app'; password.value = 'Demo@1234'; form.requestSubmit(); }
            }, 'Fill and sign in')
          )
        : null
    );
    setTimeout(() => (isLogin ? email : name).focus(), 60);
  }

  render();
}
