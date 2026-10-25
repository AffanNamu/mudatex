# Sakash app changes (Flutter)

**Not compiled or run.** There is no Flutter toolchain in the environment these were written in. They are written against
the code as read (`AffanNamu/PFB` at commit `a52d3bd`) and should be applied on a branch, built, and tried against the
Paystack **test** keys before release. File and line numbers refer to that commit.

The goal: the app creates an *unpaid* order, asks the server to start payment for **that order**, and then only *watches*
the order until the server (the Paystack webhook) marks it paid. The app can no longer mark anything paid, and no longer
chooses the amount.

## 1. `lib/core/constants/app_constants.dart`

Delete `supabaseFunctionSecret` (line 75). The app must not hold a secret. The payment function now identifies the caller
by their Firebase sign-in.

## 2. `lib/services/firebase_service.dart`: `placeOrder` (line 1541)

Change the signature and what it writes, so an order starts unpaid, and so nothing is announced or cleared until it is
paid. It also returns the new order id.

```dart
Future<String> placeOrder(
  List<Map<String, dynamic>> cart, {
  String? couponCode,
  double deliveryFee = 0.0,
  String? notes,
}) async {
  final user = currentUser;
  if (user == null || cart.isEmpty) throw StateError('Sign in and add items first');

  // Only what the server needs to price the order. Prices sent here are ignored by the server.
  final lines = [
    for (final i in cart)
      {'productId': i['productId'], 'qty': i['qty'] ?? 1, 'name': i['name']},
  ];

  // ... keep the existing delivery-address and findNearestAdmin / _superAdminFallback block unchanged ...

  final orderId = DateTime.now().millisecondsSinceEpoch.toString();
  final orderMap = {
    'userId': user.uid,
    'items': lines,
    'totalAmount': 0,            // set by the server when payment starts
    'deliveryFee': deliveryFee,
    'couponCode': couponCode ?? '',
    'paymentReference': '',
    'paymentStatus': 'unpaid',
    'notes': notes ?? '',
    'status': 'awaiting_payment',
    'createdAt': DateTime.now().toIso8601String(),
    'deliveryAddress': deliveryAddress,
    // ... keep the existing assignedAdmin* fields as they are ...
  };
  await firestore.collection(AppConstants.ordersCollection).doc(orderId).set(orderMap);
  return orderId;
  // Removed from here: clearCart() and the three notification blocks. They move to section 5.
}
```

Remove the `paymentReference`, `paymentStatus` and `couponDiscount` parameters: the discount is worked out by the server
from `couponCode`. The old default `paymentStatus = 'paid'` is the root of the problem and must not survive.

## 3. `lib/services/payment_service.dart`

Delete these members entirely: `generateReference`, `createPaymentAttempt`, `markPaymentAttemptInitialized`,
`markPaymentAttemptSuccess`, `markPaymentAttemptFailure`, `createVerifiedPaymentRecord`, `confirmManualPaymentSuccess`
(lines 120 to 378 other than the settings helpers). Replace `initializeCheckout` with:

```dart
import 'package:firebase_auth/firebase_auth.dart';

Future<PaymentResult> startCheckout({required String orderId}) async {
  final config = await getPaymentConfig();
  if (!config.paystackEnabled || config.activeGateway != 'paystack') {
    return const PaymentResult(success: false, reference: '', message: 'Online payment is currently unavailable');
  }
  final idToken = await FirebaseAuth.instance.currentUser?.getIdToken();
  if (idToken == null) {
    return const PaymentResult(success: false, reference: '', message: 'Please sign in again');
  }
  final response = await _client.post(
    Uri.parse(AppConstants.supabasePaystackInitializeFunctionUrl),
    headers: {'Content-Type': 'application/json', 'Authorization': 'Bearer $idToken'},
    body: jsonEncode({'orderId': orderId}),
  );
  final decoded = jsonDecode(response.body) as Map<String, dynamic>;
  if (response.statusCode != 200 || decoded['success'] != true) {
    return PaymentResult(success: false, reference: '', message: (decoded['error'] ?? 'Unable to start payment').toString());
  }
  return PaymentResult(
    success: true,
    reference: decoded['reference'].toString(),
    message: 'Payment started',
    authorizationUrl: decoded['authorizationUrl'].toString(),
  );
}
```

Keep `getPaymentConfig`, `watchPaymentConfig`, `updatePaymentConfig`, `seedPaymentConfigIfMissing` and `openCheckoutUrl`.
(The customer-facing amount comes back from the server, not from the app's own arithmetic.)

## 4. `lib/models/payment_session_model.dart`

Replace the fields with `reference`, `orderId`. Nothing about amounts or items is needed any more.

## 5. `lib/features/cart/presentation/screens/cart_screen.dart` (around lines 270 to 400)

Create the order first, then start payment for it:

```dart
final orderId = await _firebaseService.placeOrder(
  cartItems,
  couponCode: _couponApplied ? _couponCtrl.text.trim() : null,
  deliveryFee: deliveryFee,
);
final result = await _paymentService.startCheckout(orderId: orderId);
if (!result.success) { /* show result.message */ return; }
final opened = await _paymentService.openCheckoutUrl(result.authorizationUrl);
// ... then push PaystackVerificationScreen(session: PaymentSessionModel(reference: result.reference, orderId: orderId))
```

The coupon list (lines 225 to 255) and the totals shown on screen stay as a *preview*; the amount charged is the
server's. If the preview and the server disagree, the customer sees the server's figure in the Paystack page.

## 6. `lib/features/cart/presentation/screens/paystack_verification_screen.dart`

Remove `_verifyNow` and its button. Watch the order instead:

```dart
StreamBuilder<DocumentSnapshot<Map<String, dynamic>>>(
  stream: FirebaseFirestore.instance.collection('orders').doc(widget.session.orderId).snapshots(),
  builder: (context, snap) {
    final paid = snap.data?.data()?['paymentStatus'] == 'paid';
    if (paid && !_finished) {
      _finished = true;                                   // a State field, so this runs once
      WidgetsBinding.instance.addPostFrameCallback((_) async {
        await _firebaseService.clearCart();
        if (mounted) Navigator.of(context).popUntil((r) => r.isFirst);
      });
    }
    return paid
        ? const Text('Payment confirmed. Your order is placed.')
        : const Text('Waiting for payment confirmation. This usually takes a few seconds after you pay. '
                     'If you have paid and this does not change, contact support with your reference.');
  },
)
```

Notifications that `placeOrder` used to send (customer "Order placed", admin "New order assigned", escalation) must now
be sent when the order becomes paid. The simplest place is the webhook function, once it can send FCM; until then, send
them from the admin side when an order with `paymentStatus == 'paid'` first appears.

## 7. Admin screens

Orders with `status == 'awaiting_payment'` must not appear in admin work queues or counts (`watchOrders`,
`watchOrdersCount`, the assignment counters). Filter on `paymentStatus == 'paid'`.
