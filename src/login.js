
// Simple login handler
document.addEventListener('DOMContentLoaded', () => {
    const loginForm = document.getElementById('loginForm');

    if (loginForm) {
        loginForm.addEventListener('submit', (e) => {
            e.preventDefault();

            const btn = loginForm.querySelector('button[type="submit"]');
            const originalText = btn.innerHTML;

            // Add loading state
            btn.innerHTML = '<span class="spinner" style="border-width: 2px; width: 20px; height: 20px;"></span> Signing In...';
            btn.disabled = true;
            btn.style.opacity = '0.7';
            btn.style.cursor = 'not-allowed';

            const username = document.getElementById('username').value;
            const password = document.getElementById('password').value;

            // Simulate API call
            setTimeout(() => {
                if (username === 'SS-COP' && password === 'SS-COP') {
                    console.log(`Login successful: ${username}`);
                    window.location.href = 'index.html';
                } else {
                    alert('Invalid credentials. Please use Username: SS-COP, Password: SS-COP');
                    // Reset button
                    btn.innerHTML = originalText;
                    btn.disabled = false;
                    btn.style.opacity = '1';
                    btn.style.cursor = 'pointer';
                }
            }, 1000);
        });
    }

    // Auto-focus username
    const usernameInput = document.getElementById('username');
    if (usernameInput) {
        usernameInput.focus();
    }
});
