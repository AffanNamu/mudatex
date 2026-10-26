-- Customer-facing commerce, part 6: product reviews. Only a customer who has had the product shipped to them may review
-- it, one review each, and a person approves it before the public sees it.

CREATE TABLE product_reviews (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id       uuid NOT NULL REFERENCES organizations(id),
  storefront_product_id uuid NOT NULL REFERENCES storefront_products(id),
  customer_id           uuid NOT NULL REFERENCES customers(id),
  order_id              uuid NOT NULL REFERENCES sales_orders(id),
  rating                int NOT NULL CHECK (rating BETWEEN 1 AND 5),
  title                 text,
  body                  text NOT NULL,
  display_name          text NOT NULL,
  status                text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'published', 'rejected')),
  moderated_by          uuid REFERENCES users(id),
  moderated_at          timestamptz,
  created_at            timestamptz NOT NULL DEFAULT now(),
  UNIQUE (storefront_product_id, customer_id)
);
CREATE INDEX product_reviews_public ON product_reviews (storefront_product_id, created_at DESC) WHERE status = 'published';
CREATE INDEX product_reviews_queue ON product_reviews (organization_id, status, created_at);

INSERT INTO role_permissions (role_id, permission)
SELECT id, 'reviews.moderate' FROM roles WHERE key = 'group_admin'
ON CONFLICT DO NOTHING;
