// public/redirect.js
(function () {
    const queryElement = document.getElementById('query-string');
    if (!queryElement) return;
  
    const query = queryElement.dataset.query;
  
    // ✅ Hardcoded redirect
    const redirectUrl = "https://9b0d-2405-9800-bc30-195a-f5fc-1eb6-e471-54f3.ngrok-free.app/callback?" + query;
  
    window.location.href = redirectUrl;
  })();
  