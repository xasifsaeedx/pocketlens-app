-- Store Plaid personal_finance_category.detailed for finer categorization guesses
-- (e.g. FOOD_AND_DRINK_GROCERIES vs FOOD_AND_DRINK_RESTAURANT).
alter table transactions add column plaid_category_detail text;
