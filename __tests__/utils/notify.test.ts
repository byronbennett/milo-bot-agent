import { sendNotification } from '../../app/utils/notify.js';

describe('sendNotification', () => {
  test('does not throw on any platform', () => {
    expect(() => {
      sendNotification('Test Title', 'Test message body');
    }).not.toThrow();
  });

  test('handles special characters in title and message', () => {
    expect(() => {
      sendNotification('Title "with" quotes', 'Message with "quotes" & $pecial chars\nnewlines');
    }).not.toThrow();
  });

  test('handles empty strings', () => {
    expect(() => {
      sendNotification('', '');
    }).not.toThrow();
  });
});
