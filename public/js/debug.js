window.onerror = function (message, source, lineno, colno, error) {
    alert('Error: ' + message + '\nLine: ' + lineno);
};

window.addEventListener('unhandledrejection', function (event) {
    alert('Unhandled Rejection: ' + event.reason);
});
